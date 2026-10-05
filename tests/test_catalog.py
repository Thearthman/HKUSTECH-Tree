from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from hkust_tree.catalog import (
    CatalogStore,
    iter_course_refs,
    normalize_course_code,
    parse_course_page,
    parse_requirement,
    parse_subject_index,
)


def subject_index(year: str = "2026-27") -> str:
    return f"""
    <!doctype html><html><head><title>Program &amp; Course Catalog</title></head><body>
      <h1 class="page-title">Undergraduate Courses {year}</h1>
      <ul class="subject-list">
        <li class="subject"><a href="/ugcourse/{year}/COMP/"></a>
          <div class="subject-code">COMP</div><div class="subject-name">Computer Science and Engineering</div></li>
        <li class="subject"><a href="/ugcourse/{year}/MATH/"></a>
          <div class="subject-code">MATH</div><div class="subject-name">Mathematics</div></li>
        <li class="subject"><a href="/ugcourse/{year}/ELEC/"></a>
          <div class="subject-code">ELEC</div><div class="subject-name">Electronic and Computer Engineering</div></li>
      </ul>
    </body></html>
    """


def course_item(
    code: str,
    title: str,
    *,
    prerequisite: str | None = None,
    corequisite: str | None = None,
    exclusion: str | None = None,
) -> str:
    rows = []
    for label, value in (
        ("Prerequisite(s)", prerequisite),
        ("Corequisite(s)", corequisite),
        ("Exclusion(s)", exclusion),
    ):
        if value:
            rows.append(
                f'<div class="data-row data-row-default"><div class="header">{label}</div>'
                f'<div class="data">{value}</div></div>'
            )
    rows.append(
        '<div class="data-row data-row-long"><div class="header">Description</div>'
        f'<div class="data">Description for {code} with <strong>real markup</strong>.</div></div>'
    )
    return f"""
      <li class="crse accordion-item">
        <div class="crse-header accordion-item-header">
          <div class="crse-code">{code}</div><div class="crse-title">{title}</div>
          <div class="crse-unit">3 Credit(s)</div>
        </div>
        <div class="crse-detail accordion-item-content">{''.join(rows)}</div>
      </li>
    """


def course_page(subject: str, *items: str, year: str = "2026-27") -> str:
    return f"""
    <!doctype html><html><head><title>HKUST {subject}</title></head><body>
      <h1 class="page-title">{subject} Courses {year}</h1>
      <div class="subject-name"><div class="subject-code">{subject}</div>
        <div class="subject-formal-desc">Department</div></div>
      <ul class="crse-list">{''.join(items)}</ul>
    </body></html>
    """


@pytest.fixture
def catalog_pages() -> dict[str, str]:
    return {
        "index": subject_index(),
        "COMP": course_page(
            "COMP",
            course_item(
                "COMP 1001",
                "Programming Fundamentals",
                corequisite="MATH 1001 OR ELEC 1001",
                exclusion="any COMP courses of 2000-level or above",
            ),
            course_item("COMP 1021", "Introduction to Computing"),
            course_item("COMP 2011", "Object-Oriented Programming", prerequisite="COMP1001 or COMP 1021"),
            course_item(
                "COMP 4211",
                "Machine Learning",
                prerequisite="MATH 1012 (prior to 2025-26) OR MATH 1013",
            ),
            course_item(
                "COMP 3001",
                "Integrated Systems",
                prerequisite="COMP 2011 AND MATH 1001",
                corequisite="ELEC 1001",
                exclusion="COMP 3999 (prior to 2025-26)",
            ),
            course_item("COMP 4001", "Advanced Systems", prerequisite="COMP 3001"),
        ),
        "MATH": course_page(
            "MATH",
            course_item("MATH 1001", "Calculus"),
            course_item("MATH 1013", "Calculus II"),
        ),
        "ELEC": course_page(
            "ELEC",
            course_item("ELEC 1001", "Circuits", prerequisite="MATH 1001", corequisite="COMP 3001"),
        ),
    }


def sync_from_pages(store: CatalogStore, monkeypatch: pytest.MonkeyPatch, pages: dict[str, str]) -> dict:
    def fake_fetch(_session, url: str) -> str:
        if url.rstrip("/").endswith("2026-27"):
            return pages["index"]
        for subject in ("COMP", "MATH", "ELEC"):
            if f"/{subject}/" in url:
                return pages[subject]
        raise AssertionError(f"Unexpected URL {url}")

    monkeypatch.setattr(store, "_fetch_html", fake_fetch)
    return store.sync("2026-27")


def test_normalize_course_codes() -> None:
    assert normalize_course_code("math2211") == "MATH 2211"
    assert normalize_course_code("COMP-2012h") == "COMP 2012H"
    assert normalize_course_code("ELEC_2600") == "ELEC 2600"
    assert normalize_course_code("not a course") is None


def test_nested_boolean_parser_preserves_precedence_and_compact_codes() -> None:
    requirement = parse_requirement(
        "COMP 2611 OR [ELEC 2350 AND (COMP2011 or COMP 2012H)]"
    )
    expression = requirement["expression"]
    assert requirement["status"] == "parsed"
    assert expression["type"] == "any"
    assert expression["items"][0] == {"type": "course", "code": "COMP 2611"}
    assert expression["items"][1]["type"] == "all"
    assert list(iter_course_refs(expression)) == [
        "COMP 2611",
        "ELEC 2350",
        "COMP 2011",
        "COMP 2012H",
    ]


def test_grade_or_above_is_a_qualifier_not_a_boolean_split() -> None:
    requirement = parse_requirement(
        "(Grade A or above in COMP 1023) OR "
        "(Grade A or above in COMP 1021 AND Pass grade in COMP 1028)"
    )
    expression = requirement["expression"]
    assert expression["type"] == "any"
    assert expression["items"][0] == {
        "type": "course",
        "code": "COMP 1023",
        "qualifier": "Grade A or above",
    }
    assert expression["items"][1]["type"] == "all"
    assert expression["items"][1]["items"][1]["qualifier"] == "Pass grade"


def test_slash_temporal_pattern_and_text_conditions() -> None:
    slash = parse_requirement("Grade A- or above in COMP 2012 / COMP 2012H")
    assert slash["expression"]["type"] == "any"
    assert slash["expression"]["items"][0]["qualifier"] == "Grade A- or above"

    temporal = parse_requirement("COMP 1022P (prior to 2025-26)")
    assert temporal["expression"]["qualifier"] == "prior to 2025-26"

    pattern = parse_requirement("any COMP courses of 3000‐level or above", "exclusion")
    assert pattern["expression"] == {
        "type": "coursePattern",
        "subject": "COMP",
        "minimumLevel": 3,
        "text": "any COMP courses of 3000-level or above",
    }

    condition = parse_requirement("Level 5* or above in HKDSE Mathematics Extended Module M1/M2")
    assert condition["expression"]["type"] == "condition"
    assert condition["status"] == "parsed"

    malformed = parse_requirement("COMP 2011 AND [MATH 1001")
    assert malformed["status"] == "partial"
    assert malformed["warnings"] == ["Unbalanced requirement grouping"]


def test_dom_extractors_validate_page_identity_and_preserve_raw_wording() -> None:
    subjects = parse_subject_index(subject_index(), "2026-27")
    assert [subject["code"] for subject in subjects] == ["COMP", "MATH", "ELEC"]
    assert subjects[0]["name"] == "Computer Science and Engineering"

    html = course_page(
        "COMP",
        course_item(
            "COMP 3511",
            "Operating System",
            prerequisite="COMP 2611 OR [ELEC 2350 AND (COMP 2011 OR COMP 2012H)]",
            exclusion="COMP 4511",
        ),
    )
    courses = parse_course_page(html, "2026-27", "COMP")
    assert courses[0]["code"] == "COMP 3511"
    assert courses[0]["description"] == "Description for COMP 3511 with real markup ."
    assert courses[0]["requirements"]["prerequisite"]["raw"].startswith("COMP 2611 OR")

    with pytest.raises(ValueError, match="2025-26"):
        parse_subject_index(subject_index(), "2025-26")
    with pytest.raises(ValueError, match="MATH"):
        parse_course_page(html, "2026-27", "MATH")


def test_sync_search_detail_and_flattened_refs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    progress: list[dict] = []
    store = CatalogStore(tmp_path / "catalog.sqlite")
    monkeypatch.setattr(
        store,
        "_fetch_html",
        lambda _session, url: (
            catalog_pages["index"]
            if url.rstrip("/").endswith("2026-27")
            else next(catalog_pages[key] for key in ("COMP", "MATH", "ELEC") if f"/{key}/" in url)
        ),
    )
    result = store.sync("2026-27", progress.append)

    assert result["status"] == "success"
    assert result["subject_count"] == 3
    assert result["course_count"] == 9
    assert progress[0]["stage"] == "index"
    assert progress[-1]["stage"] == "complete"
    assert store.catalogs()[0]["sync_status"] == "success"

    search = store.search_courses("2026-27", "advanced")
    assert [course["code"] for course in search] == ["COMP 4001"]
    assert store.search_courses("2026-27", "comp4001")[0]["code"] == "COMP 4001"
    detail = store.get_course("2026-27", "comp3001")
    assert detail is not None
    assert detail["requirements"]["prerequisite"]["expression"]["type"] == "all"
    assert detail["requirements"]["exclusion"]["expression"]["qualifier"] == "prior to 2025-26"
    assert detail["requirements"]["corequisite"]["raw"] == "ELEC 1001"

    with sqlite3.connect(tmp_path / "catalog.sqlite") as connection:
        refs = connection.execute(
            "SELECT relation, referenced_code, qualifier FROM requirement_refs "
            "WHERE course_code = 'COMP 3001' ORDER BY relation, referenced_code"
        ).fetchall()
    assert refs == [
        ("corequisite", "ELEC 1001", None),
        ("exclusion", "COMP 3999", "prior to 2025-26"),
        ("prerequisite", "COMP 2011", None),
        ("prerequisite", "MATH 1001", None),
    ]


def test_failed_refresh_keeps_last_good_catalog(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    store = CatalogStore(tmp_path / "catalog.sqlite")
    sync_from_pages(store, monkeypatch, catalog_pages)
    original = store.get_course("2026-27", "COMP 4001")

    monkeypatch.setattr(store, "_fetch_html", lambda _session, _url: "<html>error</html>")
    with pytest.raises(ValueError, match="subject index"):
        store.sync("2026-27")

    assert store.get_course("2026-27", "COMP 4001") == original
    assert store.catalogs()[0]["sync_status"] == "failed"


def test_sync_retries_http_200_error_page_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    store = CatalogStore(tmp_path / "catalog.sqlite", max_attempts=2)
    attempts: dict[str, int] = {}

    def fake_fetch(_session, url: str) -> str:
        key = "index" if url.rstrip("/").endswith("2026-27") else next(
            subject for subject in ("COMP", "MATH", "ELEC") if f"/{subject}/" in url
        )
        attempts[key] = attempts.get(key, 0) + 1
        if key == "COMP" and attempts[key] == 1:
            return "<html><h1>Service temporarily unavailable</h1></html>"
        return catalog_pages[key]

    monkeypatch.setattr(store, "_fetch_html", fake_fetch)
    result = store.sync("2026-27")
    assert result["status"] == "success"
    assert attempts["COMP"] == 2


def test_graph_recurses_all_relations_levels_boolean_nodes_and_placeholders(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    store = CatalogStore(tmp_path / "catalog.sqlite")
    sync_from_pages(store, monkeypatch, catalog_pages)
    graph = store.build_graph("2026-27", "COMP 4001")

    courses = {node["code"]: node for node in graph["nodes"] if node["type"] == "course"}
    assert courses["COMP 1001"]["level"] == 1
    assert courses["COMP 2011"]["level"] == 2
    assert courses["COMP 3001"]["level"] == 3
    assert courses["ELEC 1001"]["level"] == 3  # same band as its corequisite
    assert courses["COMP 4001"]["level"] == 4
    assert courses["COMP 3999"]["placeholder"] is True
    assert any(node["type"] == "any" for node in graph["nodes"])
    assert any(edge["relation"] == "corequisite" and edge.get("symmetric") for edge in graph["edges"])
    assert any(edge["relation"] == "exclusion" and edge.get("symmetric") for edge in graph["edges"])
    unresolved = next(item for item in graph["diagnostics"] if item["type"] == "unresolved")
    assert unresolved["courses"] == ["COMP 3999"]

    shallow = store.build_graph("2026-27", "COMP 4001", depth=1, relations="prerequisites")
    shallow_codes = {node.get("code") for node in shallow["nodes"]}
    assert "COMP 3001" in shallow_codes
    assert "COMP 2011" not in shallow_codes
    assert shallow["relations"] == ["prerequisite"]


def test_any_prerequisite_uses_known_alternative_for_course_level(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    store = CatalogStore(tmp_path / "catalog.sqlite")
    sync_from_pages(store, monkeypatch, catalog_pages)
    graph = store.build_graph("2026-27", "COMP 4211", relations="prerequisite")

    course_nodes = {
        node["code"]: node for node in graph["nodes"] if node["type"] == "course"
    }
    # MATH 1012 is historical/unresolved, but the current MATH 1013 branch is
    # valid, so the ANY prerequisite still places COMP 4211 at level 2.
    assert course_nodes["COMP 4211"]["level"] == 2
    assert course_nodes["MATH 1013"]["level"] == 1
    assert course_nodes["MATH 1012"]["placeholder"] is True
    assert not any(item["type"] == "cycle" for item in graph["diagnostics"])


def test_any_prerequisite_uses_deepest_visible_alternative_for_layout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    catalog_pages["COMP"] = course_page(
        "COMP",
        course_item("COMP 1001", "Foundation"),
        course_item("COMP 2001", "Intermediate", prerequisite="COMP 1001"),
        course_item(
            "COMP 3001",
            "Alternative Paths",
            prerequisite="COMP 1001 OR COMP 2001 OR COMP 9999",
        ),
    )
    store = CatalogStore(tmp_path / "catalog.sqlite")
    sync_from_pages(store, monkeypatch, catalog_pages)
    graph = store.build_graph("2026-27", "COMP 3001", relations="prerequisite")

    course_nodes = {
        node["code"]: node for node in graph["nodes"] if node["type"] == "course"
    }
    assert course_nodes["COMP 1001"]["level"] == 1
    assert course_nodes["COMP 2001"]["level"] == 2
    assert course_nodes["COMP 3001"]["level"] == 3
    assert course_nodes["COMP 9999"]["placeholder"] is True


def test_boolean_junctions_do_not_add_levels_and_hide_unrelated_cycles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    catalog_pages["COMP"] = course_page(
        "COMP",
        course_item("COMP 1001", "First Foundation"),
        course_item("COMP 1002", "Second Foundation"),
        course_item("COMP 1003", "Third Foundation"),
        course_item(
            "COMP 2001",
            "Nested Requirements",
            prerequisite="COMP 1001 AND (COMP 1002 OR COMP 1003)",
        ),
        course_item("COMP 3001", "Cycle One", prerequisite="COMP 3002"),
        course_item("COMP 3002", "Cycle Two", prerequisite="COMP 3001"),
    )
    store = CatalogStore(tmp_path / "catalog.sqlite")
    sync_from_pages(store, monkeypatch, catalog_pages)

    graph = store.build_graph("2026-27", "COMP 2001", relations="prerequisite")
    root = next(node for node in graph["nodes"] if node.get("code") == "COMP 2001")
    assert root["level"] == 2
    assert not any(item["type"] == "cycle" for item in graph["diagnostics"])

    cycle_graph = store.build_graph("2026-27", "COMP 3001", relations="prerequisite")
    cycle = next(item for item in cycle_graph["diagnostics"] if item["type"] == "cycle")
    assert cycle["courses"] == ["COMP 3001", "COMP 3002"]
    assert len(cycle["courses"]) == len(set(cycle["courses"]))


def test_graph_forward_dependents_preserve_boolean_rules_and_depth(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    catalog_pages["COMP"] = course_page(
        "COMP",
        course_item("COMP 1001", "Foundation"),
        course_item(
            "COMP 2001",
            "Alternative Consumer",
            prerequisite="COMP 1001 OR MATH 1001",
        ),
        course_item("COMP 3001", "Transitive Consumer", prerequisite="COMP 2001"),
    )
    store = CatalogStore(tmp_path / "catalog.sqlite")
    sync_from_pages(store, monkeypatch, catalog_pages)

    forward = store.build_graph(
        "2026-27",
        "COMP 1001",
        direction="forward",
        relations="prerequisite",
        depth=1,
    )
    forward_codes = {
        node.get("code") for node in forward["nodes"] if node["type"] == "course"
    }
    assert forward["direction"] == "forward"
    assert forward_codes == {"COMP 1001", "COMP 2001", "MATH 1001"}
    assert "COMP 3001" not in forward_codes
    assert any(node["type"] == "any" for node in forward["nodes"])
    assert any(
        edge["source"] == "course:COMP 1001"
        and edge["relation"] == "prerequisite"
        for edge in forward["edges"]
    )

    transitive = store.build_graph(
        "2026-27", "COMP 1001", direction="forward", relations="prerequisite", depth=2
    )
    assert any(node.get("code") == "COMP 3001" for node in transitive["nodes"])

    both = store.build_graph(
        "2026-27", "COMP 2001", direction="both", relations="prerequisite", depth=1
    )
    both_codes = {node.get("code") for node in both["nodes"] if node["type"] == "course"}
    assert {"COMP 1001", "MATH 1001", "COMP 2001", "COMP 3001"} <= both_codes

    backward = store.build_graph(
        "2026-27", "COMP 1001", direction="backward", relations="prerequisite"
    )
    assert {node.get("code") for node in backward["nodes"]} == {"COMP 1001"}

    with pytest.raises(ValueError, match="Unsupported graph direction"):
        store.build_graph("2026-27", "COMP 1001", direction="sideways")


def test_graph_cycle_is_reported_with_unknown_levels(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    catalog_pages["COMP"] = course_page(
        "COMP",
        course_item("COMP 1001", "First", prerequisite="COMP 2001"),
        course_item("COMP 2001", "Second", prerequisite="COMP 1001"),
    )
    store = CatalogStore(tmp_path / "catalog.sqlite")
    sync_from_pages(store, monkeypatch, catalog_pages)
    graph = store.build_graph("2026-27", "COMP 1001", relations=["prerequisite"])

    assert all(node["level"] is None for node in graph["nodes"] if node["type"] == "course")
    assert any(item["type"] == "cycle" for item in graph["diagnostics"])


def test_graph_node_cap_and_invalid_arguments(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_pages: dict[str, str],
) -> None:
    store = CatalogStore(tmp_path / "catalog.sqlite")
    sync_from_pages(store, monkeypatch, catalog_pages)
    graph = store.build_graph("2026-27", "COMP 4001", max_nodes=2)
    assert graph["truncated"] is True
    assert len(graph["nodes"]) == 2
    with pytest.raises(ValueError, match="Unsupported relation"):
        store.build_graph("2026-27", "COMP 4001", relations="timetable")
    with pytest.raises(KeyError):
        store.build_graph("2026-27", "COMP 9999")
    with pytest.raises(ValueError, match="Academic year"):
        store.sync("latest")


def test_requirement_ast_is_json_serializable() -> None:
    requirement = parse_requirement("MATH2211 or ELEC 2600")
    assert json.loads(json.dumps(requirement)) == requirement
