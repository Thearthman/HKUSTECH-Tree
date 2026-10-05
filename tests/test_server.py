from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

import pytest

from hkust_tree.server import StoreBackend, create_app, normalize_course_code


class FakeBackend:
    default_year = "2026-27"

    def __init__(self) -> None:
        self.release_sync = threading.Event()
        self.sync_started = threading.Event()
        self.last_graph_args: dict[str, Any] | None = None

    def list_catalogs(self):
        return [{"year": "2026-27", "courseCount": 1, "status": "ready"}]

    def search_courses(self, *, year: str, query: str, limit: int):
        items = [{"code": "COMP 4211", "title": "Machine Learning", "credits": 3}]
        return items[:limit] if query.lower() in "comp 4211 machine learning" else []

    def get_course(self, *, year: str, code: str):
        if code != "COMP 4211":
            return None
        return {"year": year, "code": code, "title": "Machine Learning", "credits": 3}

    def get_graph(
        self,
        *,
        year: str,
        code: str,
        depth: int | None,
        relations: frozenset[str],
        direction: str,
    ):
        if code != "COMP 4211":
            return None
        self.last_graph_args = {
            "year": year,
            "code": code,
            "depth": depth,
            "relations": relations,
            "direction": direction,
        }
        return {"year": year, "target": code, "nodes": [], "edges": []}

    def sync_catalog(
        self,
        *,
        year: str,
        progress: Callable[[int, int | None, str], None],
    ) -> Mapping[str, Any]:
        self.sync_started.set()
        progress(1, 2, "Fetched subjects")
        self.release_sync.wait(timeout=2)
        progress(2, 2, "Fetched courses")
        return {"year": year, "courseCount": 1}


@pytest.fixture
def backend():
    return FakeBackend()


@pytest.fixture
def client(backend, tmp_path: Path):
    (tmp_path / "index.html").write_text("<!doctype html><title>Course tree</title>")
    (tmp_path / "major-requirement.html").write_text(
        "<!doctype html><title>Major requirements</title>"
    )
    app = create_app(backend, static_folder=tmp_path)
    app.config.update(TESTING=True)
    return app.test_client()


def test_normalize_course_code():
    assert normalize_course_code("comp4211") == "COMP 4211"
    assert normalize_course_code("COMP 2012h") == "COMP 2012H"
    assert normalize_course_code("not-a-course") is None


def test_catalog_and_course_endpoints(client):
    response = client.get("/api/catalogs")
    assert response.status_code == 200
    assert response.json["defaultYear"] == "2026-27"

    response = client.get("/api/courses?q=machine")
    assert response.status_code == 200
    assert response.json["courses"][0]["code"] == "COMP 4211"

    response = client.get("/api/courses/comp4211")
    assert response.status_code == 200
    assert response.json["code"] == "COMP 4211"

    response = client.get("/api/courses/comp9999")
    assert response.status_code == 404
    assert response.json["error"]["code"] == "course_not_found"


def test_graph_parses_depth_relations_and_direction(client, backend):
    response = client.get(
        "/api/graph/COMP4211?depth=3&relations=prerequisite,corequisite&direction=forward"
    )
    assert response.status_code == 200
    assert backend.last_graph_args == {
        "year": "2026-27",
        "code": "COMP 4211",
        "depth": 3,
        "relations": frozenset({"prerequisite", "corequisite"}),
        "direction": "forward",
    }

    response = client.get("/api/graph/COMP4211")
    assert response.status_code == 200
    assert backend.last_graph_args["direction"] == "both"


@pytest.mark.parametrize(
    ("url", "error_code"),
    [
        ("/api/courses?year=2026", "invalid_year"),
        ("/api/courses?limit=none", "invalid_limit"),
        ("/api/graph/COMP4211?depth=0", "invalid_depth"),
        ("/api/graph/COMP4211?relations=unknown", "invalid_relations"),
        ("/api/graph/COMP4211?direction=sideways", "invalid_direction"),
        ("/api/courses/not-a-code", "invalid_course_code"),
    ],
)
def test_invalid_query_parameters_are_json_errors(client, url, error_code):
    response = client.get(url)
    assert response.status_code == 400
    assert response.json["error"]["code"] == error_code


def test_sync_is_background_and_rejects_duplicate(client, backend):
    response = client.post("/api/sync", json={"year": "2026-27"})
    assert response.status_code == 202
    job_id = response.json["id"]
    assert backend.sync_started.wait(timeout=1)

    duplicate = client.post("/api/sync", json={"year": "2026-27"})
    assert duplicate.status_code == 409
    assert duplicate.json["id"] == job_id

    status = client.get(f"/api/sync/{job_id}")
    assert status.status_code == 200
    assert status.json["status"] == "running"
    assert status.json["progress"] == 0.5

    backend.release_sync.set()
    for _ in range(40):
        status = client.get(f"/api/sync/{job_id}")
        if status.json["status"] == "completed":
            break
        time.sleep(0.01)
    assert status.json["status"] == "completed"
    assert status.json["result"]["courseCount"] == 1


def test_static_frontend_and_api_404(client):
    assert client.get("/").status_code == 200
    assert client.get("/ustree").status_code == 200
    assert client.get("/major-requirement").status_code == 200
    assert client.get("/major-requirement/").status_code == 200
    assert client.get("/major-requirement/").status_code == 200
    response = client.get("/missing.js")
    assert response.status_code == 404
    assert response.json["error"]["code"] == "not_found"


def test_default_app_serves_project_frontend():
    app = create_app()
    app.config.update(TESTING=True)
    with app.test_client() as default_client:
        assert default_client.get("/").status_code == 200
        assert default_client.get("/styles.css").status_code == 200
        assert default_client.get("/static/styles.css").status_code == 200
        assert default_client.get("/static/graph-interactions.js").status_code == 200
        assert default_client.get("/static/major-requirements.js").status_code == 200
        assert default_client.get("/static/data/cpeg-2025-26.pdf").status_code == 200
        assert default_client.get("/static/vendor/cytoscape.min.js").status_code == 200


def test_store_backend_adapts_catalog_callbacks():
    class Store:
        def sync(self, year, progress_callback):
            progress_callback(
                {"stage": "subjects", "subject": "COMP", "completed": 1, "queued": 2}
            )
            progress_callback({"stage": "complete", "subject_count": 3})
            return {"year": year, "course_count": 25}

        def catalogs(self):
            return []

        def search_courses(self, year, query, limit):
            return []

        def get_course(self, year, code):
            return None

        def build_graph(
            self, year, code, depth=None, relations=None, direction="backward"
        ):
            raise KeyError(code)

    updates = []
    backend = StoreBackend(Store())
    result = backend.sync_catalog(
        year="2026-27",
        progress=lambda completed, total, message: updates.append(
            (completed, total, message)
        ),
    )
    assert result["course_count"] == 25
    assert updates == [
        (1, 3, "Fetching COMP courses"),
        (3, 3, "Catalog refresh completed"),
    ]
    assert backend.get_graph(
        year="2026-27",
        code="COMP 9999",
        depth=None,
        relations=frozenset({"prerequisite"}),
        direction="backward",
    ) is None
