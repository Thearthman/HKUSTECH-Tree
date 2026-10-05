"""HKUST course catalog ingestion, requirement parsing, and graph queries.

The module deliberately exposes dictionaries instead of custom model classes.  They
can be returned directly by a small JSON HTTP API and the original catalog wording
always remains available next to its parsed representation.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


BASE_URL = "https://prog-crs.hkust.edu.hk"
DEFAULT_SUBJECTS = ("COMP", "MATH", "ELEC")
RELATIONS = ("prerequisite", "corequisite", "exclusion")
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36 HKUSTECH-Tree/1.0"
)

_COURSE_RE = re.compile(r"(?<![A-Z0-9])([A-Z]{4})\s*[-_]?\s*(\d{4}[A-Z]?)(?![A-Z0-9])", re.I)
_COURSE_FULL_RE = re.compile(r"^\s*([A-Z]{4})\s*[-_]?\s*(\d{4}[A-Z]?)\s*$", re.I)
_PATTERN_RE = re.compile(
    r"^any\s+(?P<subject>[A-Z]{4})\s+courses?\s+of\s+"
    r"(?P<level>[1-9])000[\s\-\u2010-\u2015]*level\s+or\s+above$",
    re.I,
)
_SPACE_RE = re.compile(r"\s+")
_TEMPORAL_RE = re.compile(
    r"^\s*\((?P<qualifier>(?:prior|before|from|since|in)\b[^()]*)\)", re.I
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _clean_text(value: str) -> str:
    value = value.replace("\xa0", " ")
    value = re.sub(r"[\u2010-\u2015\u2212]", "-", value)
    return _SPACE_RE.sub(" ", value).strip()


def normalize_course_code(value: str) -> str | None:
    """Return ``SUBJ 1234X`` for a course-like value, or ``None`` if invalid."""

    if not isinstance(value, str):
        return None
    match = _COURSE_FULL_RE.match(_clean_text(value).upper())
    if not match:
        return None
    return f"{match.group(1).upper()} {match.group(2).upper()}"


def _course_node(code: str, qualifier: str | None = None) -> dict[str, Any]:
    node: dict[str, Any] = {"type": "course", "code": code}
    if qualifier:
        node["qualifier"] = qualifier
    return node


def _balanced_outer_group(text: str) -> bool:
    if len(text) < 2 or text[0] not in "([" or text[-1] not in ")]":
        return False
    expected = ")" if text[0] == "(" else "]"
    if text[-1] != expected:
        return False
    stack: list[str] = []
    pairs = {")": "(", "]": "["}
    for index, char in enumerate(text):
        if char in "([":
            stack.append(char)
        elif char in ")]":
            if not stack or stack.pop() != pairs[char]:
                return False
            if not stack and index != len(text) - 1:
                return False
    return not stack


def _grouping_warnings(text: str) -> list[str]:
    stack: list[str] = []
    pairs = {")": "(", "]": "["}
    for char in text:
        if char in "([":
            stack.append(char)
        elif char in ")]":
            if not stack or stack.pop() != pairs[char]:
                return ["Unbalanced requirement grouping"]
    return [] if not stack else ["Unbalanced requirement grouping"]


def _split_top_level_word(text: str, operator: str) -> list[str]:
    """Split a Boolean word outside brackets, preserving phrases like 'or above'."""

    pieces: list[str] = []
    start = 0
    stack: list[str] = []
    pairs = {")": "(", "]": "["}
    word = re.compile(rf"(?<![A-Z0-9]){operator}(?![A-Z0-9])", re.I)
    for match in word.finditer(text):
        # Reconstruct the grouping depth at this match. Requirements are short and
        # this keeps the scanner robust in the presence of malformed closing marks.
        stack.clear()
        for char in text[: match.start()]:
            if char in "([":
                stack.append(char)
            elif char in ")]" and stack and stack[-1] == pairs[char]:
                stack.pop()
        if stack:
            continue
        if operator.upper() == "OR":
            following = text[match.end() :].lstrip().lower()
            if re.match(r"(?:above|higher|better)\b", following):
                continue
        left = text[start : match.start()].strip(" ;,")
        if left:
            pieces.append(left)
        start = match.end()
    if not pieces:
        return [text.strip()]
    tail = text[start:].strip(" ;,")
    if tail:
        pieces.append(tail)
    return pieces


def _split_top_level_chars(text: str, separators: str) -> list[str]:
    pieces: list[str] = []
    start = 0
    stack: list[str] = []
    pairs = {")": "(", "]": "["}
    for index, char in enumerate(text):
        if char in "([":
            stack.append(char)
        elif char in ")]" and stack and stack[-1] == pairs[char]:
            stack.pop()
        elif char in separators and not stack:
            item = text[start:index].strip(" ;,")
            if item:
                pieces.append(item)
            start = index + 1
    if not pieces:
        return [text.strip()]
    tail = text[start:].strip(" ;,")
    if tail:
        pieces.append(tail)
    return pieces


def _split_slash_alternatives(text: str) -> list[str]:
    pieces = _split_top_level_chars(text, "/")
    if len(pieces) < 2:
        return [text]
    # Slash is a Boolean alternative only when every side contains a course. This
    # avoids corrupting HKDSE M1/M2, P/F, and ordinary prose.
    if all(_COURSE_RE.search(piece) for piece in pieces):
        return pieces
    return [text]


def _combine(kind: str, items: Iterable[dict[str, Any]]) -> dict[str, Any]:
    flattened: list[dict[str, Any]] = []
    for item in items:
        if item.get("type") == kind:
            flattened.extend(item.get("items", []))
        else:
            flattened.append(item)
    if len(flattened) == 1:
        return flattened[0]
    return {"type": kind, "items": flattened}


def _qualifier_for_single_course(text: str, match: re.Match[str]) -> str | None:
    before = text[: match.start()].strip(" ,;:-")
    after = text[match.end() :]
    qualifiers: list[str] = []
    temporal = _TEMPORAL_RE.match(after)
    if temporal:
        qualifiers.append(temporal.group("qualifier").strip())
        after = after[temporal.end() :]
    before = re.sub(r"\bin\s*$", "", before, flags=re.I).strip(" ,;:-")
    remainder = " ".join(part for part in (before, after.strip(" ,;:-")) if part)
    if remainder:
        qualifiers.insert(0, _clean_text(remainder))
    return "; ".join(qualifiers) or None


def _parse_expression(text: str, warnings: list[str]) -> dict[str, Any]:
    text = text.strip(" ;,")
    if not text:
        warnings.append("Empty requirement expression")
        return {"type": "condition", "text": "Unspecified requirement"}

    while _balanced_outer_group(text):
        text = text[1:-1].strip()

    # AND binds tighter than OR, so split OR before recursively parsing each arm.
    parts = _split_top_level_word(text, "OR")
    if len(parts) > 1:
        return _combine("any", (_parse_expression(part, warnings) for part in parts))

    parts = _split_top_level_word(text, "AND")
    if len(parts) > 1:
        return _combine("all", (_parse_expression(part, warnings) for part in parts))

    parts = _split_slash_alternatives(text)
    if len(parts) > 1:
        return _combine("any", (_parse_expression(part, warnings) for part in parts))

    # Catalog lists use commas and, less often, semicolons as conjunctions. An
    # explicit OR after a semicolon has already been handled above.
    parts = _split_top_level_chars(text, ",;")
    if len(parts) > 1:
        return _combine("all", (_parse_expression(part, warnings) for part in parts))

    pattern = _PATTERN_RE.match(text)
    if pattern:
        return {
            "type": "coursePattern",
            "subject": pattern.group("subject").upper(),
            "minimumLevel": int(pattern.group("level")),
            "text": text,
        }

    matches = list(_COURSE_RE.finditer(text))
    if len(matches) == 1:
        match = matches[0]
        code = f"{match.group(1).upper()} {match.group(2).upper()}"
        return _course_node(code, _qualifier_for_single_course(text, match))
    if len(matches) > 1:
        warnings.append("Course references lacked an explicit Boolean connector; treated as AND")
        return _combine(
            "all",
            (
                _course_node(f"{match.group(1).upper()} {match.group(2).upper()}")
                for match in matches
            ),
        )
    return {"type": "condition", "text": text}


def parse_requirement(raw_text: str, relation: str = "prerequisite") -> dict[str, Any]:
    """Parse catalog requirement wording into a lossless Boolean expression AST."""

    if relation not in RELATIONS:
        raise ValueError(f"Unsupported relation: {relation}")
    raw = _clean_text(raw_text or "")
    warnings = _grouping_warnings(raw)
    expression = _parse_expression(raw, warnings)
    return {
        "relation": relation,
        "raw": raw,
        "status": "partial" if warnings else "parsed",
        "warnings": list(dict.fromkeys(warnings)),
        "expression": expression,
    }


def iter_course_refs(expression: Mapping[str, Any] | None) -> Iterator[str]:
    """Yield normalized course references from an expression (not its wrapper)."""

    if not expression:
        return
    node_type = expression.get("type")
    if node_type == "course":
        code = normalize_course_code(str(expression.get("code", "")))
        if code:
            yield code
    elif node_type in {"all", "any"}:
        for item in expression.get("items", []):
            yield from iter_course_refs(item)


def _iter_subject_refs(expression: Mapping[str, Any] | None) -> Iterator[str]:
    if not expression:
        return
    node_type = expression.get("type")
    if node_type == "coursePattern":
        subject = str(expression.get("subject", "")).upper()
        if re.fullmatch(r"[A-Z]{4}", subject):
            yield subject
    elif node_type == "course":
        code = normalize_course_code(str(expression.get("code", "")))
        if code:
            yield code.split()[0]
    elif node_type in {"all", "any"}:
        for item in expression.get("items", []):
            yield from _iter_subject_refs(item)


def parse_subject_index(html: str, requested_year: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.select_one("h1.page-title")
    if not title or requested_year not in title.get_text(" ", strip=True):
        raise ValueError(f"Response is not the HKUST undergraduate subject index for {requested_year}")
    subject_list = soup.select_one("ul.subject-list")
    if not subject_list:
        raise ValueError("HKUST subject index contains no subject list")
    subjects: list[dict[str, str]] = []
    for item in subject_list.select("li.subject"):
        code_element = item.select_one(".subject-code")
        name_element = item.select_one(".subject-name")
        link = item.select_one("a[href]")
        if not code_element or not name_element or not link:
            continue
        code = code_element.get_text(" ", strip=True).upper()
        if not re.fullmatch(r"[A-Z]{4}", code):
            continue
        href = str(link.get("href", ""))
        source_url = href if href.startswith("http") else f"{BASE_URL}{href}"
        subjects.append(
            {
                "code": code,
                "name": _clean_text(name_element.get_text(" ", strip=True)),
                "source_url": source_url,
            }
        )
    if not subjects:
        raise ValueError("HKUST subject index contains no valid subjects")
    return subjects


_HEADER_RELATION = {
    "prerequisite(s)": "prerequisite",
    "corequisite(s)": "corequisite",
    "exclusion(s)": "exclusion",
}


def parse_course_page(
    html: str, requested_year: str, requested_subject: str, source_url: str | None = None
) -> list[dict[str, Any]]:
    """Extract the useful fields from a server-rendered HKUST subject page."""

    subject = requested_subject.upper()
    soup = BeautifulSoup(html, "html.parser")
    title = soup.select_one("h1.page-title")
    page_subject = soup.select_one(".subject-name > .subject-code")
    course_list = soup.select_one("ul.crse-list")
    if not title or requested_year not in title.get_text(" ", strip=True):
        raise ValueError(f"Response is not an HKUST course page for {requested_year}")
    if not page_subject or page_subject.get_text(" ", strip=True).upper() != subject:
        raise ValueError(f"Response is not the HKUST {subject} course page")
    if not course_list:
        raise ValueError(f"HKUST {subject} page contains no course list")

    page_url = source_url or f"{BASE_URL}/ugcourse/{requested_year}/{subject}/"
    courses: list[dict[str, Any]] = []
    for item in course_list.select("li.crse"):
        header = item.find("div", class_="crse-header", recursive=False)
        detail = item.find("div", class_="crse-detail", recursive=False)
        if not header or not detail:
            continue
        code_element = header.select_one(".crse-code")
        title_element = header.select_one(".crse-title")
        unit_element = header.select_one(".crse-unit")
        code = normalize_course_code(code_element.get_text(" ", strip=True) if code_element else "")
        if not code or not code.startswith(f"{subject} ") or not title_element:
            continue
        description = ""
        requirements: dict[str, dict[str, Any]] = {}
        for row in detail.select(".data-row"):
            label_element = row.find("div", class_="header", recursive=False)
            data_element = row.find("div", class_="data", recursive=False)
            if not label_element or not data_element:
                continue
            label = _clean_text(label_element.get_text(" ", strip=True))
            value = _clean_text(data_element.get_text(" ", strip=True))
            if label.lower() == "description":
                description = value
            relation = _HEADER_RELATION.get(label.lower())
            if relation and value:
                requirements[relation] = parse_requirement(value, relation)
        courses.append(
            {
                "year": requested_year,
                "code": code,
                "subject": subject,
                "number": code.split()[1],
                "title": _clean_text(title_element.get_text(" ", strip=True)),
                "credits": _clean_text(unit_element.get_text(" ", strip=True)) if unit_element else "",
                "description": description,
                "source_url": page_url,
                "requirements": requirements,
            }
        )
    if not courses:
        raise ValueError(f"HKUST {subject} page contains no valid courses")
    return courses


class CatalogStore:
    """SQLite-backed catalog cache and graph query service."""

    def __init__(
        self,
        db_path: str | Path,
        *,
        base_url: str = BASE_URL,
        timeout: float = 20.0,
        max_attempts: int = 3,
    ) -> None:
        self.db_path = str(db_path)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_attempts = max(1, max_attempts)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def initialize(self) -> None:
        parent = Path(self.db_path).expanduser().parent
        if self.db_path != ":memory:":
            parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS catalogs (
                    year TEXT PRIMARY KEY,
                    source_url TEXT NOT NULL,
                    last_synced TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    subject_count INTEGER NOT NULL,
                    course_count INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS subjects (
                    year TEXT NOT NULL,
                    code TEXT NOT NULL,
                    name TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    fetched INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (year, code),
                    FOREIGN KEY (year) REFERENCES catalogs(year) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS courses (
                    year TEXT NOT NULL,
                    code TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    number TEXT NOT NULL,
                    title TEXT NOT NULL,
                    credits TEXT NOT NULL,
                    description TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    source_hash TEXT NOT NULL,
                    PRIMARY KEY (year, code),
                    FOREIGN KEY (year, subject) REFERENCES subjects(year, code) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS requirements (
                    year TEXT NOT NULL,
                    course_code TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    raw_text TEXT NOT NULL,
                    ast_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    warnings_json TEXT NOT NULL,
                    raw_hash TEXT NOT NULL,
                    PRIMARY KEY (year, course_code, relation),
                    FOREIGN KEY (year, course_code) REFERENCES courses(year, code) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS requirement_refs (
                    year TEXT NOT NULL,
                    course_code TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    referenced_code TEXT NOT NULL,
                    qualifier TEXT,
                    PRIMARY KEY (year, course_code, relation, referenced_code),
                    FOREIGN KEY (year, course_code, relation)
                        REFERENCES requirements(year, course_code, relation) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS parser_overrides (
                    raw_hash TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    ast_json TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (raw_hash, relation)
                );
                CREATE TABLE IF NOT EXISTS sync_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    year TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    status TEXT NOT NULL,
                    message TEXT NOT NULL DEFAULT '',
                    subject_count INTEGER NOT NULL DEFAULT 0,
                    course_count INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS courses_year_subject ON courses(year, subject);
                CREATE INDEX IF NOT EXISTS courses_search ON courses(year, code, title);
                CREATE INDEX IF NOT EXISTS refs_target ON requirement_refs(year, referenced_code);
                """
            )
            connection.commit()

    def _session(self) -> requests.Session:
        retry = Retry(
            total=max(0, self.max_attempts - 1),
            connect=max(0, self.max_attempts - 1),
            read=max(0, self.max_attempts - 1),
            status=max(0, self.max_attempts - 1),
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"GET"}),
            backoff_factor=0.5,
            raise_on_status=False,
        )
        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
        session.mount("https://", HTTPAdapter(max_retries=retry))
        session.mount("http://", HTTPAdapter(max_retries=retry))
        return session

    def _fetch_html(self, session: requests.Session, url: str) -> str:
        last_error: Exception | None = None
        for attempt in range(self.max_attempts):
            try:
                response = session.get(url, timeout=self.timeout)
                response.raise_for_status()
                content_type = response.headers.get("Content-Type", "")
                if "html" not in content_type.lower() and "<html" not in response.text[:1000].lower():
                    raise ValueError(f"Non-HTML response from {url}")
                if len(response.text) < 500:
                    raise ValueError(f"Incomplete HTML response from {url}")
                return response.text
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                if attempt + 1 < self.max_attempts:
                    time.sleep(0.4 * (2**attempt))
        raise RuntimeError(f"Could not fetch {url}: {last_error}") from last_error

    def _fetch_validated(
        self,
        session: requests.Session,
        url: str,
        parser: Callable[[str], Any],
    ) -> tuple[str, Any]:
        """Fetch and parse, retrying HTTP 200 responses with error-page content."""

        last_error: Exception | None = None
        for attempt in range(self.max_attempts):
            html = self._fetch_html(session, url)
            try:
                return html, parser(html)
            except ValueError as exc:
                last_error = exc
                if attempt + 1 < self.max_attempts:
                    time.sleep(0.4 * (2**attempt))
        assert last_error is not None
        raise last_error

    @staticmethod
    def _notify(callback: Callable[[dict[str, Any]], None] | None, **update: Any) -> None:
        if callback:
            callback(update)

    def sync(
        self, year: str, progress_callback: Callable[[dict[str, Any]], None] | None = None
    ) -> dict[str, Any]:
        """Synchronously refresh a year, preserving the last good copy on failure."""

        if not re.fullmatch(r"20\d{2}-\d{2}", year):
            raise ValueError("Academic year must look like 2026-27")
        self.initialize()
        started_at = _utc_now()
        with closing(self._connect()) as connection:
            cursor = connection.execute(
                "INSERT INTO sync_history(year, started_at, status) VALUES (?, ?, 'running')",
                (year, started_at),
            )
            sync_id = int(cursor.lastrowid)
            overrides = {
                (row["raw_hash"], row["relation"]): json.loads(row["ast_json"])
                for row in connection.execute("SELECT raw_hash, relation, ast_json FROM parser_overrides")
            }
            connection.commit()

        index_url = f"{self.base_url}/ugcourse/{year}"
        self._notify(progress_callback, stage="index", message=f"Fetching subjects for {year}")
        try:
            with self._session() as session:
                index_html, subjects = self._fetch_validated(
                    session, index_url, lambda html: parse_subject_index(html, year)
                )
                subject_map = {item["code"]: item for item in subjects}
                queue = deque(code for code in DEFAULT_SUBJECTS if code in subject_map)
                queued = set(queue)
                fetched_subjects: set[str] = set()
                courses: list[dict[str, Any]] = []
                page_hashes: list[str] = [hashlib.sha256(index_html.encode()).hexdigest()]

                while queue:
                    subject = queue.popleft()
                    url = subject_map[subject]["source_url"]
                    self._notify(
                        progress_callback,
                        stage="subjects",
                        subject=subject,
                        completed=len(fetched_subjects),
                        queued=len(queue) + 1,
                    )
                    html, parsed = self._fetch_validated(
                        session,
                        url,
                        lambda page, subject=subject, url=url: parse_course_page(
                            page, year, subject, url
                        ),
                    )
                    page_hash = hashlib.sha256(html.encode()).hexdigest()
                    page_hashes.append(page_hash)
                    for course in parsed:
                        course["source_hash"] = page_hash
                        for relation, requirement in course["requirements"].items():
                            raw_hash = hashlib.sha256(requirement["raw"].encode()).hexdigest()
                            override = overrides.get((raw_hash, relation))
                            if override:
                                requirement["expression"] = override
                                requirement["status"] = "overridden"
                                requirement["warnings"] = []
                            for referenced_subject in _iter_subject_refs(requirement["expression"]):
                                if referenced_subject in subject_map and referenced_subject not in queued:
                                    queued.add(referenced_subject)
                                    queue.append(referenced_subject)
                    courses.extend(parsed)
                    fetched_subjects.add(subject)

            synced_at = _utc_now()
            catalog_hash = hashlib.sha256("".join(sorted(page_hashes)).encode()).hexdigest()
            with closing(self._connect()) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("DELETE FROM catalogs WHERE year = ?", (year,))
                connection.execute(
                    """INSERT INTO catalogs
                       (year, source_url, last_synced, source_hash, subject_count, course_count)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (year, index_url, synced_at, catalog_hash, len(fetched_subjects), len(courses)),
                )
                connection.executemany(
                    """INSERT INTO subjects(year, code, name, source_url, fetched)
                       VALUES (?, ?, ?, ?, ?)""",
                    [
                        (year, item["code"], item["name"], item["source_url"], item["code"] in fetched_subjects)
                        for item in subjects
                    ],
                )
                for course in courses:
                    connection.execute(
                        """INSERT INTO courses
                           (year, code, subject, number, title, credits, description, source_url, source_hash)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            year,
                            course["code"],
                            course["subject"],
                            course["number"],
                            course["title"],
                            course["credits"],
                            course["description"],
                            course["source_url"],
                            course["source_hash"],
                        ),
                    )
                    for relation, requirement in course["requirements"].items():
                        raw_hash = hashlib.sha256(requirement["raw"].encode()).hexdigest()
                        connection.execute(
                            """INSERT INTO requirements
                               (year, course_code, relation, raw_text, ast_json, status, warnings_json, raw_hash)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                            (
                                year,
                                course["code"],
                                relation,
                                requirement["raw"],
                                json.dumps(requirement["expression"], separators=(",", ":")),
                                requirement["status"],
                                json.dumps(requirement["warnings"]),
                                raw_hash,
                            ),
                        )
                        references = _references_with_qualifiers(requirement["expression"])
                        connection.executemany(
                            """INSERT OR IGNORE INTO requirement_refs
                               (year, course_code, relation, referenced_code, qualifier)
                               VALUES (?, ?, ?, ?, ?)""",
                            [
                                (year, course["code"], relation, code, qualifier)
                                for code, qualifier in references
                            ],
                        )
                connection.execute(
                    """UPDATE sync_history SET finished_at = ?, status = 'success',
                       subject_count = ?, course_count = ? WHERE id = ?""",
                    (synced_at, len(fetched_subjects), len(courses), sync_id),
                )
                connection.commit()
            result = {
                "id": sync_id,
                "year": year,
                "status": "success",
                "last_synced": synced_at,
                "subject_count": len(fetched_subjects),
                "course_count": len(courses),
            }
            self._notify(progress_callback, stage="complete", **result)
            return result
        except Exception as exc:
            with closing(self._connect()) as connection:
                connection.execute(
                    "UPDATE sync_history SET finished_at = ?, status = 'failed', message = ? WHERE id = ?",
                    (_utc_now(), str(exc), sync_id),
                )
                connection.commit()
            self._notify(progress_callback, stage="failed", id=sync_id, year=year, message=str(exc))
            raise

    def catalogs(self) -> list[dict[str, Any]]:
        self.initialize()
        query = """
            SELECT c.*,
                   (SELECT h.status FROM sync_history h WHERE h.year = c.year
                    ORDER BY h.id DESC LIMIT 1) AS sync_status,
                   (SELECT h.message FROM sync_history h WHERE h.year = c.year
                    ORDER BY h.id DESC LIMIT 1) AS sync_message
            FROM catalogs c ORDER BY c.year DESC
        """
        with closing(self._connect()) as connection:
            return [dict(row) for row in connection.execute(query)]

    def search_courses(self, year: str, q: str, limit: int = 20) -> list[dict[str, Any]]:
        self.initialize()
        query = _clean_text(q or "").upper()
        query = normalize_course_code(query) or query
        like = f"%{query}%"
        limit = max(1, min(int(limit), 100))
        sql = """
            SELECT code, subject, number, title, credits, source_url
            FROM courses
            WHERE year = ? AND (UPPER(code) LIKE ? OR UPPER(title) LIKE ?)
            ORDER BY CASE WHEN UPPER(code) = ? THEN 0
                          WHEN UPPER(code) LIKE ? THEN 1 ELSE 2 END,
                     code
            LIMIT ?
        """
        with closing(self._connect()) as connection:
            rows = connection.execute(sql, (year, like, like, query, f"{query}%", limit))
            return [dict(row) for row in rows]

    def get_course(self, year: str, code: str) -> dict[str, Any] | None:
        self.initialize()
        normalized = normalize_course_code(code)
        if not normalized:
            return None
        with closing(self._connect()) as connection:
            row = connection.execute(
                """SELECT year, code, subject, number, title, credits, description, source_url
                   FROM courses WHERE year = ? AND code = ?""",
                (year, normalized),
            ).fetchone()
            if not row:
                return None
            result = dict(row)
            result["requirements"] = {relation: None for relation in RELATIONS}
            for requirement in connection.execute(
                """SELECT relation, raw_text, ast_json, status, warnings_json
                   FROM requirements WHERE year = ? AND course_code = ?""",
                (year, normalized),
            ):
                result["requirements"][requirement["relation"]] = {
                    "relation": requirement["relation"],
                    "raw": requirement["raw_text"],
                    "status": requirement["status"],
                    "warnings": json.loads(requirement["warnings_json"]),
                    "expression": json.loads(requirement["ast_json"]),
                }
            return result

    def _year_data(self, year: str) -> dict[str, dict[str, Any]]:
        with closing(self._connect()) as connection:
            courses = {
                row["code"]: {
                    **dict(row),
                    "requirements": {relation: None for relation in RELATIONS},
                }
                for row in connection.execute(
                    """SELECT year, code, subject, number, title, credits, description, source_url
                       FROM courses WHERE year = ?""",
                    (year,),
                )
            }
            for row in connection.execute(
                """SELECT course_code, relation, raw_text, ast_json, status, warnings_json
                   FROM requirements WHERE year = ?""",
                (year,),
            ):
                if row["course_code"] in courses:
                    courses[row["course_code"]]["requirements"][row["relation"]] = {
                        "relation": row["relation"],
                        "raw": row["raw_text"],
                        "status": row["status"],
                        "warnings": json.loads(row["warnings_json"]),
                        "expression": json.loads(row["ast_json"]),
                    }
            return courses

    def build_graph(
        self,
        year: str,
        code: str,
        depth: int | None = None,
        relations: Sequence[str] | str | None = None,
        max_nodes: int = 250,
        direction: str = "backward",
    ) -> dict[str, Any]:
        """Build a recursive, cycle-safe graph rooted at ``code``.

        ``backward`` follows the selected course's requirements, ``forward``
        follows courses whose prerequisite expression references the selected
        course, and ``both`` combines the two views. Forward dependents retain
        their complete Boolean prerequisite expression in the graph.
        """

        self.initialize()
        root = normalize_course_code(code)
        if not root:
            raise ValueError("Invalid course code")
        courses = self._year_data(year)
        if root not in courses:
            raise KeyError(root)
        if depth is not None:
            depth = max(0, int(depth))
        max_nodes = max(1, min(int(max_nodes), 2000))
        selected_relations = _normalize_relations(relations)
        direction = str(direction).strip().lower()
        if direction not in {"backward", "forward", "both"}:
            raise ValueError(f"Unsupported graph direction: {direction}")
        diagnostics: list[dict[str, Any]] = []
        level_map, level_diagnostics = _calculate_levels(courses)

        nodes: list[dict[str, Any]] = []
        node_ids: set[str] = set()
        edges: list[dict[str, Any]] = []
        edge_keys: set[tuple[Any, ...]] = set()
        expanded_backward: set[str] = set()
        expanded_forward: set[str] = set()
        unresolved: set[str] = set()
        truncated = False

        dependents_by_prerequisite: dict[str, list[str]] = defaultdict(list)
        if direction in {"forward", "both"} and "prerequisite" in selected_relations:
            for dependent_code, record in courses.items():
                requirement = record["requirements"].get("prerequisite")
                if not requirement:
                    continue
                for reference in dict.fromkeys(
                    iter_course_refs(requirement["expression"])
                ):
                    dependents_by_prerequisite[reference].append(dependent_code)
            for dependent_codes in dependents_by_prerequisite.values():
                dependent_codes.sort()

        def add_node(node: dict[str, Any]) -> bool:
            nonlocal truncated
            node_id = str(node["id"])
            if node_id in node_ids:
                return True
            if len(nodes) >= max_nodes:
                truncated = True
                return False
            node_ids.add(node_id)
            nodes.append(node)
            return True

        def add_course_node(course_code: str) -> bool:
            record = courses.get(course_code)
            if record:
                return add_node(
                    {
                        "id": f"course:{course_code}",
                        "type": "course",
                        "code": course_code,
                        "subject": record["subject"],
                        "title": record["title"],
                        "credits": record["credits"],
                        "source_url": record["source_url"],
                        "level": level_map.get(course_code),
                        "placeholder": False,
                    }
                )
            unresolved.add(course_code)
            return add_node(
                {
                    "id": f"course:{course_code}",
                    "type": "course",
                    "code": course_code,
                    "subject": course_code.split()[0],
                    "title": "Course details unavailable",
                    "credits": "",
                    "source_url": None,
                    "level": None,
                    "placeholder": True,
                }
            )

        def add_edge(
            source: str,
            target: str,
            relation: str,
            *,
            qualifier: str | None = None,
            symmetric: bool = False,
        ) -> None:
            if symmetric and source.startswith("course:") and target.startswith("course:"):
                key: tuple[Any, ...] = (relation, *sorted((source, target)))
            else:
                key = (relation, source, target, qualifier)
            if key in edge_keys or source not in node_ids or target not in node_ids:
                return
            edge_keys.add(key)
            edge: dict[str, Any] = {
                "id": f"edge:{len(edges) + 1}",
                "source": source,
                "target": target,
                "relation": relation,
            }
            if qualifier:
                edge["qualifier"] = qualifier
            if symmetric:
                edge["symmetric"] = True
            edges.append(edge)

        def emit_expression(
            expression: Mapping[str, Any],
            owner_code: str,
            relation: str,
            target_id: str,
            path: str,
            distance: int,
            *,
            expand_references: bool,
        ) -> None:
            node_type = expression.get("type")
            reverse = relation == "exclusion"
            if node_type == "course":
                referenced = normalize_course_code(str(expression.get("code", "")))
                if not referenced or not add_course_node(referenced):
                    return
                course_id = f"course:{referenced}"
                if reverse:
                    add_edge(
                        target_id,
                        course_id,
                        relation,
                        qualifier=expression.get("qualifier"),
                        symmetric=True,
                    )
                else:
                    add_edge(
                        course_id,
                        target_id,
                        relation,
                        qualifier=expression.get("qualifier"),
                        symmetric=relation == "corequisite",
                    )
                if expand_references and referenced in courses:
                    expand_backward(referenced, distance + 1)
                return
            if node_type in {"all", "any"}:
                junction_id = f"bool:{owner_code}:{relation}:{path}"
                if not add_node(
                    {
                        "id": junction_id,
                        "type": node_type,
                        "label": node_type.upper(),
                        "relation": relation,
                        "level": level_map.get(owner_code),
                    }
                ):
                    return
                if reverse:
                    add_edge(target_id, junction_id, relation, symmetric=True)
                else:
                    add_edge(junction_id, target_id, relation, symmetric=relation == "corequisite")
                for index, item in enumerate(expression.get("items", [])):
                    emit_expression(
                        item,
                        owner_code,
                        relation,
                        junction_id,
                        f"{path}.{index}",
                        distance,
                        expand_references=expand_references,
                    )
                return
            detail_id = f"{node_type or 'condition'}:{owner_code}:{relation}:{path}"
            detail_node = {
                "id": detail_id,
                "type": node_type or "condition",
                "relation": relation,
                "level": level_map.get(owner_code),
                "text": expression.get("text", "Requirement condition"),
            }
            if node_type == "coursePattern":
                detail_node.update(
                    {
                        "subject": expression.get("subject"),
                        "minimumLevel": expression.get("minimumLevel"),
                    }
                )
            if add_node(detail_node):
                if reverse:
                    add_edge(target_id, detail_id, relation, symmetric=True)
                else:
                    add_edge(detail_id, target_id, relation, symmetric=relation == "corequisite")

        def expand_backward(course_code: str, distance: int) -> None:
            if course_code in expanded_backward:
                return
            expanded_backward.add(course_code)
            if depth is not None and distance >= depth:
                return
            record = courses[course_code]
            for relation in selected_relations:
                requirement = record["requirements"].get(relation)
                if not requirement:
                    continue
                emit_expression(
                    requirement["expression"],
                    course_code,
                    relation,
                    f"course:{course_code}",
                    "0",
                    distance,
                    expand_references=True,
                )

        def expand_forward(course_code: str, distance: int) -> None:
            if course_code in expanded_forward:
                return
            expanded_forward.add(course_code)
            if depth is not None and distance >= depth:
                return
            for dependent_code in dependents_by_prerequisite.get(course_code, []):
                if not add_course_node(dependent_code):
                    continue
                requirement = courses[dependent_code]["requirements"]["prerequisite"]
                emit_expression(
                    requirement["expression"],
                    dependent_code,
                    "prerequisite",
                    f"course:{dependent_code}",
                    "0",
                    distance,
                    expand_references=False,
                )
                expand_forward(dependent_code, distance + 1)

        add_course_node(root)
        if direction in {"backward", "both"}:
            expand_backward(root, 0)
        if direction in {"forward", "both"}:
            expand_forward(root, 0)
        included_courses = {
            str(node["code"])
            for node in nodes
            if node.get("type") == "course" and node.get("code")
        }
        diagnostics.extend(
            diagnostic
            for diagnostic in level_diagnostics
            if diagnostic.get("type") != "cycle"
            or included_courses.intersection(diagnostic.get("courses", []))
        )
        if unresolved:
            diagnostics.append(
                {
                    "type": "unresolved",
                    "message": "Some referenced courses are not present in the cached catalog",
                    "courses": sorted(unresolved),
                }
            )
        if truncated:
            diagnostics.append(
                {
                    "type": "truncated",
                    "message": f"Graph reached the {max_nodes}-node safety limit",
                }
            )
        return {
            "year": year,
            "root": root,
            "relations": list(selected_relations),
            "direction": direction,
            "depth": depth,
            "nodes": nodes,
            "edges": edges,
            "diagnostics": diagnostics,
            "truncated": truncated,
        }


def _references_with_qualifiers(expression: Mapping[str, Any]) -> list[tuple[str, str | None]]:
    references: list[tuple[str, str | None]] = []
    if expression.get("type") == "course":
        code = normalize_course_code(str(expression.get("code", "")))
        if code:
            references.append((code, expression.get("qualifier")))
    for item in expression.get("items", []):
        references.extend(_references_with_qualifiers(item))
    return references


def _mandatory_course_refs(expression: Mapping[str, Any] | None) -> Iterator[str]:
    """Yield courses every valid evaluation of an expression must contain."""

    if not expression:
        return
    node_type = expression.get("type")
    if node_type == "course":
        code = normalize_course_code(str(expression.get("code", "")))
        if code:
            yield code
    elif node_type == "all":
        for item in expression.get("items", []):
            yield from _mandatory_course_refs(item)
    # No individual child of ANY is mandatory, so alternatives do not become a
    # single corequisite component. The graph still preserves the ANY rule.


def _normalize_relations(relations: Sequence[str] | str | None) -> tuple[str, ...]:
    if relations is None:
        return RELATIONS
    values = [item.strip().lower() for item in relations.split(",")] if isinstance(relations, str) else list(relations)
    aliases = {
        "prerequisites": "prerequisite",
        "prereqs": "prerequisite",
        "corequisites": "corequisite",
        "coreqs": "corequisite",
        "exclusions": "exclusion",
    }
    selected: list[str] = []
    for value in values:
        normalized = aliases.get(str(value).strip().lower(), str(value).strip().lower())
        if normalized not in RELATIONS:
            raise ValueError(f"Unsupported relation: {value}")
        if normalized not in selected:
            selected.append(normalized)
    return tuple(selected)


class _UnionFind:
    def __init__(self, items: Iterable[str]) -> None:
        self.parent = {item: item for item in items}

    def find(self, item: str) -> str:
        parent = self.parent[item]
        if parent != item:
            self.parent[item] = self.find(parent)
        return self.parent[item]

    def union(self, left: str, right: str) -> None:
        left_root, right_root = self.find(left), self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def _calculate_levels(
    courses: Mapping[str, Mapping[str, Any]],
) -> tuple[dict[str, int | None], list[dict[str, Any]]]:
    # First collapse corequisites into components. A component is the unit whose
    # level is calculated, ensuring downstream courses see the component's final
    # shared level rather than one member's provisional value.
    union_find = _UnionFind(courses)
    for course_code, record in courses.items():
        requirement = record.get("requirements", {}).get("corequisite")
        if not requirement:
            continue
        for reference in _mandatory_course_refs(requirement["expression"]):
            if reference in courses:
                union_find.union(course_code, reference)
    components: dict[str, list[str]] = defaultdict(list)
    for course_code in courses:
        components[union_find.find(course_code)].append(course_code)

    cache: dict[str, int | None] = {}
    visiting: list[str] = []
    cycle_keys: set[tuple[str, ...]] = set()

    def expression_level(expression: Mapping[str, Any] | None) -> int | None:
        """Return dependency rank without adding bands for Boolean junctions."""

        if not expression:
            return None
        node_type = expression.get("type")
        if node_type == "course":
            reference = normalize_course_code(str(expression.get("code", "")))
            if not reference or reference not in courses:
                return None
            return component_level(union_find.find(reference))
        if node_type == "all":
            children = [expression_level(item) for item in expression.get("items", [])]
            if not children or any(value is None for value in children):
                return None
            return max(children)  # type: ignore[arg-type]
        if node_type == "any":
            children = [expression_level(item) for item in expression.get("items", [])]
            known = [value for value in children if value is not None]
            return None if not known else max(known)
        # Prose conditions and broad patterns do not add dependency bands.
        return 0

    def component_level(component: str) -> int | None:
        if component in cache:
            return cache[component]
        if component in visiting:
            cycle_components = visiting[visiting.index(component) :] + [component]
            cycle_courses: set[str] = set()
            for source_component, target_component in zip(
                cycle_components, cycle_components[1:]
            ):
                for member in components[source_component]:
                    requirement = courses[member].get("requirements", {}).get(
                        "prerequisite"
                    )
                    if not requirement:
                        continue
                    for reference in iter_course_refs(requirement["expression"]):
                        if (
                            reference in courses
                            and union_find.find(reference) == target_component
                        ):
                            cycle_courses.update((member, reference))
            cycle_keys.add(tuple(sorted(cycle_courses)))
            for member_component in cycle_components:
                cache[member_component] = None
            return None

        visiting.append(component)
        member_results: list[int | None] = []
        has_requirement = False
        for member in components[component]:
            requirement = courses[member].get("requirements", {}).get("prerequisite")
            if not requirement:
                member_results.append(1)
                continue
            has_requirement = True
            dependency_rank = expression_level(requirement.get("expression"))
            member_results.append(
                None if dependency_rank is None else 1 + dependency_rank
            )

        if not has_requirement:
            result = 1
        elif any(value is None for value in member_results):
            result = None
        else:
            result = max(member_results)  # type: ignore[arg-type]
        visiting.pop()
        if component not in cache:
            cache[component] = result
        return cache[component]

    for component in components:
        component_level(component)

    course_levels = {
        course_code: cache.get(union_find.find(course_code)) for course_code in courses
    }

    diagnostics = [
        {
            "type": "cycle",
            "relation": "prerequisite",
            "message": "Prerequisite cycle prevents authoritative level calculation",
            "courses": list(cycle),
        }
        for cycle in sorted(cycle_keys)
    ]
    return course_levels, diagnostics


__all__ = [
    "CatalogStore",
    "iter_course_refs",
    "normalize_course_code",
    "parse_course_page",
    "parse_requirement",
    "parse_subject_index",
]
