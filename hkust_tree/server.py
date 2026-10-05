"""Flask HTTP interface for the local HKUST course-tree application."""

from __future__ import annotations

import re
import threading
import traceback
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence

from flask import Flask, Response, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

from .catalog import CatalogStore, normalize_course_code


DEFAULT_YEAR = "2026-27"
YEAR_RE = re.compile(r"^\d{4}-\d{2}$")
RELATIONS = frozenset({"prerequisite", "corequisite", "exclusion"})
DIRECTIONS = frozenset({"backward", "forward", "both"})


class NotFoundError(LookupError):
    """Raised when a requested catalog object does not exist."""


class CatalogUnavailableError(RuntimeError):
    """Raised when no usable local catalog has been synchronized yet."""


class ApiBackend(Protocol):
    """Small service boundary used by the HTTP layer."""

    default_year: str

    def list_catalogs(self) -> Sequence[Mapping[str, Any]]: ...

    def search_courses(
        self, *, year: str, query: str, limit: int
    ) -> Sequence[Mapping[str, Any]]: ...

    def get_course(self, *, year: str, code: str) -> Mapping[str, Any] | None: ...

    def get_graph(
        self,
        *,
        year: str,
        code: str,
        depth: int | None,
        relations: frozenset[str],
        direction: str,
    ) -> Mapping[str, Any] | None: ...

    def sync_catalog(
        self,
        *,
        year: str,
        progress: Callable[[int, int | None, str], None],
    ) -> Mapping[str, Any] | None: ...


class NullBackend:
    """Useful default that keeps the static application and diagnostics online."""

    default_year = DEFAULT_YEAR

    def list_catalogs(self) -> Sequence[Mapping[str, Any]]:
        return []

    def search_courses(
        self, *, year: str, query: str, limit: int
    ) -> Sequence[Mapping[str, Any]]:
        return []

    def get_course(self, *, year: str, code: str) -> Mapping[str, Any] | None:
        return None

    def get_graph(
        self,
        *,
        year: str,
        code: str,
        depth: int | None,
        relations: frozenset[str],
        direction: str,
    ) -> Mapping[str, Any] | None:
        return None

    def sync_catalog(
        self,
        *,
        year: str,
        progress: Callable[[int, int | None, str], None],
    ) -> Mapping[str, Any] | None:
        raise CatalogUnavailableError("catalog synchronization is not configured")


class StoreBackend:
    """Adapt :class:`CatalogStore` to the route-facing service boundary."""

    def __init__(self, store: CatalogStore, *, default_year: str = DEFAULT_YEAR) -> None:
        self.store = store
        self.default_year = default_year

    def list_catalogs(self) -> Sequence[Mapping[str, Any]]:
        return self.store.catalogs()

    def search_courses(
        self, *, year: str, query: str, limit: int
    ) -> Sequence[Mapping[str, Any]]:
        return self.store.search_courses(year, query, limit)

    def get_course(self, *, year: str, code: str) -> Mapping[str, Any] | None:
        return self.store.get_course(year, code)

    def get_graph(
        self,
        *,
        year: str,
        code: str,
        depth: int | None,
        relations: frozenset[str],
        direction: str,
    ) -> Mapping[str, Any] | None:
        try:
            return self.store.build_graph(
                year,
                code,
                depth=depth,
                relations=sorted(relations),
                direction=direction,
            )
        except KeyError:
            return None

    def sync_catalog(
        self,
        *,
        year: str,
        progress: Callable[[int, int | None, str], None],
    ) -> Mapping[str, Any] | None:
        completed = 0

        def report(update: dict[str, Any]) -> None:
            nonlocal completed
            stage = str(update.get("stage", "sync"))
            message = str(update.get("message") or _sync_message(update))
            if stage == "subjects":
                completed = int(update.get("completed", completed))
                queued = int(update.get("queued", 0))
                progress(completed, completed + queued, message)
            elif stage == "complete":
                total = int(update.get("subject_count", completed))
                progress(total, total, message)
            else:
                progress(completed, None, message)

        return self.store.sync(year, progress_callback=report)


def _sync_message(update: Mapping[str, Any]) -> str:
    stage = update.get("stage")
    if stage == "subjects":
        subject = update.get("subject")
        return f"Fetching {subject} courses" if subject else "Fetching courses"
    if stage == "complete":
        return "Catalog refresh completed"
    if stage == "failed":
        return "Catalog refresh failed"
    return "Refreshing catalog"


def default_backend() -> StoreBackend:
    """Build the normal SQLite-backed service using environment overrides."""

    import os

    default_path = Path(__file__).resolve().parent.parent / "data" / "catalog.sqlite3"
    database = Path(os.environ.get("HKUST_TREE_DB", default_path)).expanduser()
    year = os.environ.get("HKUST_TREE_YEAR", DEFAULT_YEAR)
    return StoreBackend(CatalogStore(database), default_year=year)


def _timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class SyncJob:
    id: str
    year: str
    status: str = "queued"
    completed: int = 0
    total: int | None = None
    message: str = "Waiting to start"
    warnings: list[str] = field(default_factory=list)
    result: Mapping[str, Any] | None = None
    error: str | None = None
    created_at: str = field(default_factory=_timestamp)
    started_at: str | None = None
    finished_at: str | None = None


class SyncRegistry:
    """In-memory job state for the single-process local server."""

    def __init__(self, backend: ApiBackend) -> None:
        self._backend = backend
        self._jobs: dict[str, SyncJob] = {}
        self._active_by_year: dict[str, str] = {}
        self._lock = threading.Lock()

    def start(self, year: str) -> tuple[SyncJob, bool]:
        with self._lock:
            active_id = self._active_by_year.get(year)
            if active_id:
                return self._jobs[active_id], False

            job = SyncJob(id=uuid.uuid4().hex, year=year)
            self._jobs[job.id] = job
            self._active_by_year[year] = job.id

        thread = threading.Thread(
            target=self._run,
            args=(job.id,),
            name=f"catalog-sync-{year}",
            daemon=True,
        )
        thread.start()
        return job, True

    def get(self, job_id: str) -> SyncJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _run(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.status = "running"
            job.started_at = _timestamp()
            job.message = "Starting catalog refresh"

        def progress(completed: int, total: int | None, message: str) -> None:
            with self._lock:
                current = self._jobs[job_id]
                current.completed = max(0, completed)
                current.total = total if total is None else max(0, total)
                current.message = message

        try:
            result = self._backend.sync_catalog(year=job.year, progress=progress)
        except Exception as exc:  # Background failures are surfaced through job state.
            with self._lock:
                job.status = "failed"
                job.error = str(exc) or type(exc).__name__
                job.message = "Catalog refresh failed"
                job.finished_at = _timestamp()
                self._active_by_year.pop(job.year, None)
            return

        with self._lock:
            job.status = "completed"
            job.result = result
            job.message = "Catalog refresh completed"
            job.finished_at = _timestamp()
            self._active_by_year.pop(job.year, None)


def _job_payload(job: SyncJob) -> dict[str, Any]:
    payload = asdict(job)
    if job.total:
        payload["progress"] = min(1.0, job.completed / job.total)
    else:
        payload["progress"] = None
    return payload


def create_app(
    backend: ApiBackend | None = None,
    *,
    static_folder: str | Path | None = None,
) -> Flask:
    """Create the Flask app with an injectable catalog/graph backend."""

    frontend = (
        Path(static_folder)
        if static_folder
        else Path(__file__).resolve().parent.parent / "static"
    )
    app = Flask(__name__, static_folder=None)
    app.config["JSON_SORT_KEYS"] = False
    app.config["BACKEND"] = backend or default_backend()
    app.config["SYNC_REGISTRY"] = SyncRegistry(app.config["BACKEND"])
    app.config["FRONTEND_DIR"] = frontend

    def error(status: int, code: str, message: str, **details: Any) -> tuple[Response, int]:
        body: dict[str, Any] = {"error": {"code": code, "message": message}}
        if details:
            body["error"]["details"] = details
        return jsonify(body), status

    def year_arg(*, body: Mapping[str, Any] | None = None) -> str | None:
        source = body.get("year") if body else request.args.get("year")
        value = source or app.config["BACKEND"].default_year or DEFAULT_YEAR
        return value if isinstance(value, str) and YEAR_RE.fullmatch(value) else None

    @app.after_request
    def add_local_cache_headers(response: Response) -> Response:
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    def health() -> Response:
        return jsonify({"status": "ok"})

    @app.get("/api/catalogs")
    def catalogs() -> Response:
        items = list(app.config["BACKEND"].list_catalogs())
        return jsonify({"catalogs": items, "defaultYear": app.config["BACKEND"].default_year})

    @app.post("/api/sync")
    def start_sync() -> tuple[Response, int]:
        body = request.get_json(silent=True)
        if body is None:
            body = {}
        if not isinstance(body, dict):
            return error(400, "invalid_request", "Request body must be a JSON object")
        year = year_arg(body=body)
        if year is None:
            return error(400, "invalid_year", "Academic year must use the form YYYY-YY")

        job, started = app.config["SYNC_REGISTRY"].start(year)
        response = jsonify(_job_payload(job))
        response.headers["Location"] = f"/api/sync/{job.id}"
        return response, 202 if started else 409

    @app.get("/api/sync/<job_id>")
    def sync_status(job_id: str) -> tuple[Response, int] | Response:
        job = app.config["SYNC_REGISTRY"].get(job_id)
        if job is None:
            return error(404, "sync_not_found", "Synchronization job was not found")
        return jsonify(_job_payload(job))

    @app.get("/api/courses")
    def search_courses() -> tuple[Response, int] | Response:
        year = year_arg()
        if year is None:
            return error(400, "invalid_year", "Academic year must use the form YYYY-YY")
        query = request.args.get("q", "").strip()
        try:
            limit = int(request.args.get("limit", "30"))
        except ValueError:
            return error(400, "invalid_limit", "Limit must be an integer")
        if not 1 <= limit <= 100:
            return error(400, "invalid_limit", "Limit must be between 1 and 100")

        courses = app.config["BACKEND"].search_courses(
            year=year, query=query, limit=limit
        )
        return jsonify({"courses": list(courses), "year": year, "query": query})

    @app.get("/api/courses/<path:raw_code>")
    def course_detail(raw_code: str) -> tuple[Response, int] | Response:
        year = year_arg()
        if year is None:
            return error(400, "invalid_year", "Academic year must use the form YYYY-YY")
        code = normalize_course_code(raw_code)
        if code is None:
            return error(400, "invalid_course_code", "Use a course code such as COMP 4211")
        course = app.config["BACKEND"].get_course(year=year, code=code)
        if course is None:
            return error(404, "course_not_found", f"{code} is not in the {year} catalog")
        return jsonify(course)

    @app.get("/api/graph/<path:raw_code>")
    def graph(raw_code: str) -> tuple[Response, int] | Response:
        year = year_arg()
        if year is None:
            return error(400, "invalid_year", "Academic year must use the form YYYY-YY")
        code = normalize_course_code(raw_code)
        if code is None:
            return error(400, "invalid_course_code", "Use a course code such as COMP 4211")

        raw_depth = request.args.get("depth", "all").lower()
        if raw_depth == "all":
            depth = None
        else:
            try:
                depth = int(raw_depth)
            except ValueError:
                return error(400, "invalid_depth", "Depth must be 1-20 or 'all'")
            if not 1 <= depth <= 20:
                return error(400, "invalid_depth", "Depth must be 1-20 or 'all'")

        raw_relations = request.args.get("relations", ",".join(sorted(RELATIONS)))
        relations = frozenset(part.strip().lower() for part in raw_relations.split(",") if part.strip())
        unknown = relations - RELATIONS
        if not relations or unknown:
            return error(
                400,
                "invalid_relations",
                "Relations must include prerequisite, corequisite, or exclusion",
                unknown=sorted(unknown),
            )

        direction = request.args.get("direction", "both").strip().lower()
        if direction not in DIRECTIONS:
            return error(
                400,
                "invalid_direction",
                "Direction must be backward, forward, or both",
            )

        result = app.config["BACKEND"].get_graph(
            year=year,
            code=code,
            depth=depth,
            relations=relations,
            direction=direction,
        )
        if result is None:
            return error(404, "course_not_found", f"{code} is not in the {year} catalog")
        return jsonify(result)

    @app.get("/")
    def index() -> Response | tuple[Response, int]:
        index_path = app.config["FRONTEND_DIR"] / "index.html"
        if not index_path.is_file():
            return error(503, "frontend_unavailable", "Frontend assets have not been installed")
        return send_from_directory(app.config["FRONTEND_DIR"], "index.html")

    @app.get("/major-requirement", strict_slashes=False)
    def major_requirement() -> Response | tuple[Response, int]:
        page_path = app.config["FRONTEND_DIR"] / "major-requirement.html"
        if not page_path.is_file():
            return error(503, "frontend_unavailable", "Major requirement assets have not been installed")
        return send_from_directory(app.config["FRONTEND_DIR"], "major-requirement.html")

    @app.get("/static/<path:asset>")
    def static_asset(asset: str) -> Response | tuple[Response, int]:
        path = app.config["FRONTEND_DIR"] / asset
        if path.is_file():
            return send_from_directory(app.config["FRONTEND_DIR"], asset)
        return error(404, "not_found", "Resource was not found")

    @app.get("/<path:asset>")
    def frontend_asset(asset: str) -> Response | tuple[Response, int]:
        if asset == "api" or asset.startswith("api/"):
            return error(404, "not_found", "API endpoint was not found")
        path = app.config["FRONTEND_DIR"] / asset
        if path.is_file():
            return send_from_directory(app.config["FRONTEND_DIR"], asset)
        if "." not in Path(asset).name:
            index_path = app.config["FRONTEND_DIR"] / "index.html"
            if index_path.is_file():
                return send_from_directory(app.config["FRONTEND_DIR"], "index.html")
        return error(404, "not_found", "Resource was not found")

    @app.errorhandler(CatalogUnavailableError)
    def catalog_unavailable(exc: CatalogUnavailableError) -> tuple[Response, int]:
        return error(503, "catalog_unavailable", str(exc))

    @app.errorhandler(NotFoundError)
    def not_found(exc: NotFoundError) -> tuple[Response, int]:
        return error(404, "not_found", str(exc))

    @app.errorhandler(HTTPException)
    def http_error(exc: HTTPException) -> tuple[Response, int]:
        return error(exc.code or 500, exc.name.lower().replace(" ", "_"), exc.description)

    @app.errorhandler(Exception)
    def unexpected(exc: Exception) -> tuple[Response, int]:
        if app.testing:
            raise exc
        app.logger.error("Unhandled request error\n%s", traceback.format_exc())
        return error(500, "internal_error", "The local server encountered an error")

    return app
