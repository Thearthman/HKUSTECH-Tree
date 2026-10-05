(function () {
  "use strict";

  var PROGRAM_SOURCE = "/data/cpeg-2025-26.pdf";
  var CATALOG_YEAR = "2026-27";
  var CATALOG_ROOT = "https://prog-crs.hkust.edu.hk/ugcourse/" + CATALOG_YEAR + "/";
  var MOBILE_QUERY = "(max-width: 620px)";
  var STORAGE_PREFIX = "hkust-course-tree";
  var COMPLETION_HIT_SIZE = 25;

  function checkboxImage(completed) {
    var fill = completed ? "#176b4b" : "rgba(255,255,255,0.9)";
    var stroke = completed ? "#176b4b" : "#59665e";
    var check = completed
      ? '<path d="M4 8.2 6.8 11 12.5 5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
      : "";
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      '<rect x="1" y="1" width="14" height="14" rx="2" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>' +
      check + "</svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  var CHECKBOX_EMPTY_IMAGE = checkboxImage(false);
  var CHECKBOX_COMPLETE_IMAGE = checkboxImage(true);

  function course(code, title, credits, parent, position) {
    return {
      code: code,
      title: title,
      credits: String(credits),
      parent: parent || null,
      position: position || null,
      major: true,
      graph: Boolean(position),
      source: CATALOG_ROOT + code.split(" ")[0],
      requirements: []
    };
  }

  var courses = [
    course("COMP 1023", "Introduction to Python Programming", 3, "group:fundamentals", [130, 150]),
    course("MATH 1013", "Calculus I", 3, "group:calculus-one", [365, 105]),
    course("MATH 1023", "Honors Calculus I", 3, "group:calculus-one", [365, 205]),
    course("MATH 1014", "Calculus II", 3, "group:calculus-two", [585, 105]),
    course("MATH 1024", "Honors Calculus II", 3, "group:calculus-two", [585, 205]),
    course("MATH 1020", "Accelerated Calculus", 4, "group:calculus", [805, 150]),
    course("MATH 2011", "Introduction to Multivariable Calculus", 3, "group:fundamentals", [1025, 105]),
    course("MATH 2111", "Matrix Algebra and Applications", 3, "group:fundamentals", [1025, 205]),
    course("PHYS 1112", "General Physics I with Calculus", 3, "group:physics-one", [1250, 105]),
    course("PHYS 1312", "Honors General Physics I", 3, "group:physics-one", [1250, 205]),
    course("PHYS 1114", "General Physics II", 3, "group:physics-two", [1470, 105]),
    course("PHYS 1314", "Honors General Physics II", 3, "group:physics-two", [1470, 205]),

    course("CPEG 1930", "Academic and Professional Development I", 0, "group:required", [130, 590]),
    course("CPEG 2930", "Academic and Professional Development II", 0, "group:required", [130, 690]),
    course("CPEG 3930", "Academic and Professional Development III", 0, "group:required", [130, 790]),
    course("COMP 2011", "Programming with C++", 4, "group:programming-sequence", [365, 625]),
    course("COMP 2012", "Object-Oriented Programming and Data Structures", 4, "group:programming-sequence", [585, 625]),
    course("COMP 2012H", "Honors Object-Oriented Programming and Data Structures", 5, "group:programming", [805, 675]),
    course("COMP 2611", "Computer Organization", 4, "group:organization", [1025, 625]),
    course("ELEC 2350", "Introduction to Computer Organization and Design", 4, "group:organization", [1025, 725]),
    course("COMP 2711", "Discrete Mathematical Tools for Computer Science", 4, "group:discrete", [1250, 625]),
    course("COMP 2711H", "Honors Discrete Mathematical Tools for Computer Science", 4, "group:discrete", [1250, 725]),
    course("COMP 3511", "Operating Systems", 3, "group:required", [1470, 675]),
    course("ELEC 1100", "Introduction to Electro-Robot Design", 4, "group:required", [240, 945]),
    course("ELEC 2100", "Signals and Systems", 4, "group:required", [460, 945]),
    course("ELEC 2400", "Electronic Circuits", 4, "group:required", [680, 945]),
    course("ELEC 2600", "Probability and Random Processes in Engineering", 4, "group:required", [900, 945]),
    course("ELEC 3300", "Introduction to Embedded Systems", 4, "group:required", [1120, 945]),
    course("CPEG 1971", "Industrial Experience", 0, "group:project-standard", [365, 1210]),
    course("CPEG 4901", "Computer Engineering Final Year Project in COMP", 6, "group:project-choice", [585, 1160]),
    course("CPEG 4902", "Computer Engineering Final Year Thesis in COMP", 6, "group:project-choice", [585, 1260]),
    course("CPEG 4911", "Computer Engineering Final Year Project in ELEC", 6, "group:project-choice", [805, 1160]),
    course("CPEG 4912", "Computer Engineering Final Year Thesis in ELEC", 6, "group:project-choice", [805, 1260]),
    course("CPEG 4910", "Co-op Program", 6, "group:project", [1060, 1210])
  ];
  var majorCourses = courses.slice();

  var groupNodes = [
    ["group:fundamentals", "Engineering fundamentals | AND", "and", null],
    ["group:calculus", "Calculus | OR", "or", "group:fundamentals"],
    ["group:calculus-sequence", "Two-course sequence | AND", "and", "group:calculus"],
    ["group:calculus-one", "Calculus I | OR", "or", "group:calculus-sequence"],
    ["group:calculus-two", "Calculus II | OR", "or", "group:calculus-sequence"],
    ["group:physics-one", "Physics I | OR", "or", "group:fundamentals"],
    ["group:physics-two", "Physics II | OR", "or", "group:fundamentals"],
    ["group:required", "Required courses | AND", "and", null],
    ["group:programming", "Programming | OR", "or", "group:required"],
    ["group:programming-sequence", "Standard sequence | AND", "and", "group:programming"],
    ["group:organization", "Computer organization | OR", "or", "group:required"],
    ["group:discrete", "Discrete mathematics | OR", "or", "group:required"],
    ["group:project", "Capstone route | OR", "or", "group:required"],
    ["group:project-standard", "Project route | AND", "and", "group:project"],
    ["group:project-choice", "Project or thesis | OR", "or", "group:project-standard"]
  ];

  var contextRows = [
    ["COMP 1021", "Introduction to Computer Science"], ["COMP 1022P", "Introduction to Computing with Java"],
    ["COMP 1028", "Extended Python Programming Bridging Course"], ["COMP 1029P", "Python Programming Bridging Course"],
    ["COMP 2211", "Introduction to Artificial Intelligence"], ["CIVL 1121", "Introduction to Computation for Civil Engineers"],
    ["IEDA 1180", "Python for Analytics"], ["ISOM 3400", "Business Applications Development in Python"],
    ["MATH 1003", "Calculus and Linear Algebra"], ["MATH 1012", "Calculus IA"],
    ["MATH 2023", "Multivariable Calculus"], ["MATH 2024", "Honors Multivariable Calculus"],
    ["MATH 2121", "Linear Algebra"], ["MATH 2131", "Honors in Linear and Abstract Algebra I"],
    ["MATH 2343", "Discrete Structures"], ["MATH 2350", "Applied Linear Algebra and Differential Equations"],
    ["MATH 2351", "Introduction to Differential Equations"],
    ["MATH 2352", "Differential Equations"], ["MATH 2421", "Probability"],
    ["MATH 2431", "Honors Probability"], ["PHYS 1111", "General Physics I"],
    ["ISDN 4000F", "Special Topics"], ["ELEC 2600H", "Honors Probability and Random Processes"]
  ];

  contextRows.forEach(function (row, index) {
    courses.push({
      code: row[0], title: row[1], credits: "", major: false, graph: true,
      parent: null, position: [1780 + (index % 2) * 220, 110 + Math.floor(index / 2) * 108],
      source: CATALOG_ROOT + row[0].split(" ")[0], requirements: []
    });
  });

  var relations = [];

  function addRelation(target, relation, groups, raw) {
    (groups || []).forEach(function (refs, groupIndex) {
      refs.forEach(function (source) {
        relations.push({
          source: source,
          target: target,
          relation: relation,
          group: groupIndex + 1,
          raw: raw
        });
      });
    });
    var targetCourse = courses.find(function (item) { return item.code === target; });
    if (targetCourse) targetCourse.requirements.push({ relation: relation, raw: raw });
  }

  addRelation("COMP 1023", "exclusion", [["COMP 1021", "COMP 1022P", "COMP 1029P", "COMP 2011", "COMP 2012H", "COMP 2211", "CIVL 1121", "IEDA 1180", "ISOM 3400"]], "COMP 1021, COMP 1022P (prior to 2025-26), COMP 1029P, COMP 2011, COMP 2012H, COMP 2211, CIVL 1121, IEDA 1180, ISOM 3400");
  addRelation("COMP 2011", "prerequisite", [["COMP 1023", "COMP 1028"]], "COMP 1023 OR COMP 1028");
  addRelation("COMP 2011", "exclusion", [["COMP 2012H"]], "COMP 2012H");
  addRelation("COMP 2012", "prerequisite", [["COMP 2011"]], "COMP 2011");
  addRelation("COMP 2012", "exclusion", [["COMP 2012H"]], "COMP 2012H");
  addRelation("COMP 2012H", "prerequisite", [["COMP 1023", "COMP 1021", "COMP 1028"]], "Grade A or above in COMP 1023 OR (grade A or above in COMP 1021 AND pass grade in COMP 1028)");
  addRelation("COMP 2012H", "exclusion", [["COMP 2011", "COMP 2012"]], "COMP 2011, COMP 2012");
  addRelation("COMP 2611", "prerequisite", [["COMP 2011", "COMP 2012H"]], "COMP 2011 OR COMP 2012H");
  addRelation("COMP 2611", "exclusion", [["ELEC 2350"]], "ELEC 2350");
  addRelation("COMP 2711", "corequisite", [["MATH 1012", "MATH 1013", "MATH 1014", "MATH 1020", "MATH 1023", "MATH 1024"]], "For students without prerequisites: MATH 1012 (prior to 2025-26) OR MATH 1013 OR MATH 1014 OR MATH 1020 OR MATH 1023 OR MATH 1024");
  addRelation("COMP 2711", "exclusion", [["COMP 2711H", "MATH 2343"]], "COMP 2711H, MATH 2343");
  addRelation("COMP 2711H", "prerequisite", [["MATH 1014", "MATH 1020", "MATH 1024"]], "Level 5* or above in HKDSE Mathematics Extended Module M1/M2; OR grade A- or above in MATH 1014; OR grade B+ or above in MATH 1020 / MATH 1024");
  addRelation("COMP 2711H", "exclusion", [["COMP 2711", "MATH 2343"]], "COMP 2711, MATH 2343");
  addRelation("COMP 3511", "prerequisite", [["COMP 2611", "ELEC 2350", "COMP 2011", "COMP 2012H"]], "COMP 2611 OR [ELEC 2350 AND (COMP 2011 OR COMP 2012H)]");
  addRelation("MATH 1013", "exclusion", [["MATH 1012", "MATH 1014", "MATH 1020", "MATH 1023", "MATH 1024"]], "MATH 1012 (prior to 2025-26), MATH 1014, MATH 1020, MATH 1023, MATH 1024");
  addRelation("MATH 1014", "prerequisite", [["MATH 1012", "MATH 1013", "MATH 1023", "MATH 1003"]], "MATH 1012 (prior to 2025-26) OR MATH 1013 OR MATH 1023 OR grade A- or above in MATH 1003");
  addRelation("MATH 1014", "exclusion", [["MATH 1020", "MATH 1024"]], "MATH 1020, MATH 1024");
  addRelation("MATH 1020", "exclusion", [["MATH 1013", "MATH 1014", "MATH 1023", "MATH 1024"]], "MATH 1013, MATH 1014, MATH 1023, MATH 1024");
  addRelation("MATH 1023", "exclusion", [["MATH 1012", "MATH 1013", "MATH 1014", "MATH 1024"]], "MATH 1012 (prior to 2025-26), MATH 1013, MATH 1014, MATH 1024");
  addRelation("MATH 1024", "prerequisite", [["MATH 1023"]], "MATH 1023");
  addRelation("MATH 1024", "exclusion", [["MATH 1014"]], "MATH 1014");
  addRelation("MATH 2011", "prerequisite", [["MATH 1014", "MATH 1020", "MATH 1024"]], "A passing grade in AL Pure Mathematics / AL Applied Mathematics; OR MATH 1014; OR MATH 1020; OR MATH 1024");
  addRelation("MATH 2011", "exclusion", [["MATH 2023", "MATH 2024"]], "MATH 2023, MATH 2024");
  addRelation("MATH 2111", "prerequisite", [["MATH 1014", "MATH 1020", "MATH 1024"]], "A passing grade in AL Pure Mathematics / AL Applied Mathematics; OR MATH 1014 OR MATH 1020 OR MATH 1024");
  addRelation("MATH 2111", "exclusion", [["MATH 2121", "MATH 2131", "MATH 2350"]], "MATH 2121, MATH 2131, MATH 2350");
  addRelation("PHYS 1112", "exclusion", [["PHYS 1111", "PHYS 1312"]], "PHYS 1111, PHYS 1312");
  addRelation("PHYS 1114", "prerequisite", [["PHYS 1111", "PHYS 1112", "PHYS 1312"], ["MATH 1013", "MATH 1020", "MATH 1023"]], "(PHYS 1111 OR PHYS 1112 OR PHYS 1312) AND (level 3 or above in HKDSE Mathematics Extended Module M1/M2 OR MATH 1013 OR MATH 1020 OR MATH 1023)");
  addRelation("PHYS 1114", "exclusion", [["PHYS 1314"]], "PHYS 1314");
  addRelation("PHYS 1312", "exclusion", [["PHYS 1111", "PHYS 1112"]], "PHYS 1111, PHYS 1112");
  addRelation("PHYS 1314", "prerequisite", [["PHYS 1111", "PHYS 1112", "PHYS 1312"], ["MATH 1013", "MATH 1020", "MATH 1023"]], "(grade A- or above in PHYS 1111 OR PHYS 1112 OR grade B- or above in PHYS 1312) AND (Level 5 or above in HKDSE Mathematics Extended Module M1/M2 OR MATH 1013 OR MATH 1020 OR MATH 1023)");
  addRelation("PHYS 1314", "exclusion", [["PHYS 1114"]], "PHYS 1114");
  addRelation("ELEC 2100", "prerequisite", [["MATH 2011", "MATH 2023", "MATH 2111", "MATH 2350", "MATH 2351", "MATH 2352"]], "MATH 2011 OR MATH 2023 OR MATH 2111 OR MATH 2350 OR MATH 2351 OR MATH 2352");
  addRelation("ELEC 2350", "prerequisite", [["ELEC 1100"]], "ELEC 1100");
  addRelation("ELEC 2350", "exclusion", [["COMP 2611", "ISDN 4000F"]], "COMP 2611, ISDN 4000F");
  addRelation("ELEC 2400", "prerequisite", [["ELEC 1100"], ["MATH 1003", "MATH 1014", "MATH 1020", "MATH 1024"]], "ELEC 1100 AND (MATH 1003 OR MATH 1014 OR MATH 1020 OR MATH 1024)");
  addRelation("ELEC 2400", "corequisite", [["PHYS 1114", "PHYS 1314"]], "PHYS 1114 OR PHYS 1314");
  addRelation("ELEC 2600", "prerequisite", [["MATH 1003", "MATH 1014", "MATH 1020", "MATH 1024"]], "MATH 1003 OR MATH 1014 OR MATH 1020 OR MATH 1024");
  addRelation("ELEC 2600", "corequisite", [["MATH 2011", "MATH 2023"]], "MATH 2011 OR MATH 2023");
  addRelation("ELEC 2600", "exclusion", [["ELEC 2600H", "MATH 2421", "MATH 2431"]], "ELEC 2600H (prior to 2022-23), MATH 2421, MATH 2431");
  addRelation("ELEC 3300", "prerequisite", [["COMP 2611", "ELEC 2350", "ISDN 4000F"]], "COMP 2611 OR ELEC 2350 OR ISDN 4000F");
  addRelation("CPEG 4910", "exclusion", [["CPEG 4901", "CPEG 4902", "CPEG 4911", "CPEG 4912"]], "CPEG 4901, CPEG 4902, CPEG 4911, CPEG 4912");

  var DATA = {
    id: "CPEG-2025-26",
    program: "BEng in Computer Engineering",
    intake: "2025-26",
    totalCredits: "61-66",
    source: PROGRAM_SOURCE,
    courses: majorCourses,
    contextCourses: courses.filter(function (item) { return !item.major; }),
    groups: groupNodes,
    relations: relations
  };
  window.MajorRequirementsData = DATA;

  var courseByCode = new Map(courses.map(function (item) { return [item.code, item]; }));
  var elements = {
    relationInputs: Array.prototype.slice.call(document.querySelectorAll(".relations input")),
    graphTab: document.getElementById("majorGraphTab"),
    outlineTab: document.getElementById("majorOutlineTab"),
    graphPanel: document.getElementById("majorGraphPanel"),
    outlinePanel: document.getElementById("majorOutlinePanel"),
    graphCanvas: document.getElementById("majorGraphCanvas"),
    graphEmpty: document.getElementById("majorGraphEmpty"),
    outlineContent: document.getElementById("majorOutlineContent"),
    zoomOut: document.getElementById("majorZoomOut"),
    zoomIn: document.getElementById("majorZoomIn"),
    fit: document.getElementById("majorFit"),
    drawer: document.getElementById("majorDetailsDrawer"),
    drawerSubject: document.getElementById("majorDetailsSubject"),
    drawerCode: document.getElementById("majorDetailsCode"),
    drawerContent: document.getElementById("majorDetailsContent"),
    closeDrawer: document.getElementById("majorCloseDrawer"),
    drawerScrim: document.getElementById("majorDrawerScrim")
  };
  var state = {
    cy: null,
    mobile: window.matchMedia(MOBILE_QUERY).matches,
    detailCache: new Map(),
    detailRequest: 0,
    completions: new Set()
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function nodeId(code) {
    return "course:" + code;
  }

  function completionKey() {
    return STORAGE_PREFIX + ":completed:" + CATALOG_YEAR;
  }

  function loadCompletions() {
    var values = [];
    try {
      values = JSON.parse(localStorage.getItem(completionKey()) || "[]");
    } catch (_error) {
      values = [];
    }
    state.completions = new Set(Array.isArray(values) ? values.map(String) : []);
  }

  function saveCompletions() {
    try {
      localStorage.setItem(completionKey(), JSON.stringify(Array.from(state.completions).sort()));
    } catch (_error) {
      // Completion remains available for this session when storage is unavailable.
    }
  }

  function setCourseCompletion(code, completed) {
    if (completed) state.completions.add(code);
    else state.completions.delete(code);
    saveCompletions();
    if (state.cy) state.cy.getElementById(nodeId(code)).toggleClass("is-completed", completed);
    var toggle = document.getElementById("majorCompletedToggle");
    if (toggle && elements.drawerCode.textContent === code) toggle.checked = completed;
  }

  function completionHit(node, renderedPosition) {
    if (!renderedPosition || !node.hasClass("course")) return false;
    var box = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    return renderedPosition.x >= box.x1 &&
      renderedPosition.x <= box.x1 + COMPLETION_HIT_SIZE &&
      renderedPosition.y >= box.y1 &&
      renderedPosition.y <= box.y1 + COMPLETION_HIT_SIZE;
  }

  function subjectClass(code) {
    var subject = code.split(" ")[0].toLowerCase();
    return ["comp", "math", "elec"].indexOf(subject) >= 0 ? "subject-" + subject : "subject-other";
  }

  function graphElements() {
    var nodes = groupNodes.map(function (row) {
      return {
        group: "nodes",
        data: { id: row[0], label: row[1], kind: row[2], parent: row[3] || undefined },
        classes: "requirement-group logic-" + row[2]
      };
    });

    courses.filter(function (item) { return item.graph; }).forEach(function (item) {
      nodes.push({
        group: "nodes",
        data: {
          id: nodeId(item.code), code: item.code, title: item.title,
          label: item.code + "\n" + item.title,
          parent: item.parent || undefined,
          major: item.major ? 1 : 0
        },
        position: { x: item.position[0], y: item.position[1] },
        classes: "course " + subjectClass(item.code) + " " +
          (item.major ? "major-course" : "context-course") +
          (state.completions.has(item.code) ? " is-completed" : "")
      });
    });

    var edges = relations.filter(function (item) {
      return courseByCode.has(item.source) && courseByCode.get(item.source).graph;
    }).map(function (item, index) {
      var sourceCourse = courseByCode.get(item.source);
      var targetCourse = courseByCode.get(item.target);
      var contextRelationship = !sourceCourse.major || !targetCourse || !targetCourse.major;
      return {
        group: "edges",
        data: {
          id: "major-edge:" + index,
          source: nodeId(item.source),
          target: nodeId(item.target),
          relation: item.relation,
          owner: item.target,
          hoverGroup: item.group
        },
        classes: "relationship " + item.relation + (contextRelationship ? " context-relationship" : "")
      };
    });
    return nodes.concat(edges);
  }

  function graphStyles() {
    return [
      { selector: "node", style: {
        "font-family": "Inter, system-ui, sans-serif", "overlay-opacity": 0,
        "text-wrap": "wrap", "line-height": 1.3, "color": "#1d2420"
      } },
      { selector: "node.course", style: {
        "width": 184, "height": 66, "shape": "round-rectangle", "background-color": "#fff",
        "border-color": "#b9c2bc", "border-width": 1.5, "label": "data(label)",
        "font-size": 10, "font-weight": 600, "text-max-width": 158,
        "text-valign": "center", "text-halign": "center",
        "background-image": CHECKBOX_EMPTY_IMAGE, "background-fit": "none",
        "background-repeat": "no-repeat", "background-width": 16, "background-height": 16,
        "background-position-x": "0%", "background-position-y": "0%",
        "background-offset-x": 7, "background-offset-y": 7, "background-image-opacity": 1
      } },
      { selector: "node.is-completed", style: {
        "background-color": "#e8f3ed", "background-image": CHECKBOX_COMPLETE_IMAGE
      } },
      { selector: "node.major-course", style: { "border-width": 3.5, "background-color": "#fff", "opacity": 1 } },
      { selector: "node.context-course", style: {
        "background-color": "#f0f2ef", "border-color": "#9da6a0", "border-width": 1,
        "color": "#667069", "opacity": 0.42
      } },
      { selector: "node.subject-comp.major-course", style: { "border-color": "#147b58" } },
      { selector: "node.subject-math.major-course", style: { "border-color": "#2667a8" } },
      { selector: "node.subject-elec.major-course", style: { "border-color": "#b36a16" } },
      { selector: "node.subject-other.major-course", style: { "border-color": "#69736d" } },
      { selector: "node.requirement-group", style: {
        "shape": "round-rectangle", "background-color": "#ffffff", "background-opacity": 0.22,
        "border-color": "#8f9a93", "border-width": 2, "padding": 26,
        "label": "data(label)", "font-size": 11, "font-weight": 700,
        "text-valign": "top", "text-halign": "center", "text-margin-y": -9,
        "compound-sizing-wrt-labels": "include", "min-width": 80, "min-height": 74
      } },
      { selector: "node.logic-and", style: { "border-style": "solid", "background-color": "#f7faf7" } },
      { selector: "node.logic-or", style: { "border-style": "dotted", "border-width": 3, "background-color": "#f4f8fb" } },
      { selector: "node.requirement-summary", style: {
        "width": 250, "height": 72, "shape": "round-rectangle", "background-color": "#fffaf0",
        "border-color": "#bda36e", "border-width": 2, "label": "data(label)",
        "font-size": 10, "font-weight": 600, "text-valign": "center", "text-halign": "center"
      } },
      { selector: "edge", style: {
        "width": 2, "curve-style": "unbundled-bezier", "control-point-distances": 28,
        "line-color": "#3d4b43", "target-arrow-color": "#3d4b43", "target-arrow-shape": "triangle",
        "opacity": 0.24, "overlay-opacity": 0
      } },
      { selector: "edge.context-relationship", style: { "opacity": 0.1 } },
      { selector: "edge.corequisite", style: {
        "line-color": "#2673a8", "target-arrow-color": "#2673a8", "target-arrow-shape": "none", "line-style": "dashed"
      } },
      { selector: "edge.exclusion", style: {
        "line-color": "#b14c45", "target-arrow-color": "#b14c45", "target-arrow-shape": "none", "line-style": "dotted"
      } },
      { selector: "node:selected", style: { "border-color": "#17281f", "border-width": 5, "opacity": 1 } },
      { selector: ".filtered", style: { "display": "none" } },
      { selector: ".hover-faded", style: { "opacity": 0.09 } },
      { selector: "node.hover-related", style: { "opacity": 1 } },
      { selector: "edge.hover-related", style: { "opacity": 1, "width": 3.5 } },
      { selector: "node.hover-group-1", style: { "background-color": "#c6def2" } },
      { selector: "edge.hover-group-1", style: { "line-color": "#3e718f", "target-arrow-color": "#3e718f", "width": 4 } },
      { selector: "node.hover-group-2", style: { "background-color": "#fff1c9" } },
      { selector: "edge.hover-group-2", style: { "line-color": "#8a6918", "target-arrow-color": "#8a6918", "width": 4 } },
      { selector: "node.hover-group-3", style: { "background-color": "#c5e4cf" } },
      { selector: "edge.hover-group-3", style: { "line-color": "#387354", "target-arrow-color": "#387354", "width": 4 } }
    ];
  }

  function applyRelationFilters() {
    if (!state.cy) return;
    var enabled = new Set(elements.relationInputs.filter(function (input) { return input.checked; })
      .map(function (input) { return input.value; }));
    state.cy.edges(".relationship").forEach(function (edge) {
      edge.toggleClass("filtered", !enabled.has(edge.data("relation")));
    });
    state.cy.nodes(".context-course").forEach(function (node) {
      var hasVisibleRelationship = node.connectedEdges().some(function (edge) {
        return !edge.hasClass("filtered");
      });
      node.toggleClass("filtered", !hasVisibleRelationship);
    });
    elements.graphCanvas.dataset.visibleMajorCourses = String(state.cy.nodes(".major-course").length);
    elements.graphCanvas.dataset.visibleContextCourses = String(state.cy.nodes(".context-course").not(".filtered").length);
    elements.graphCanvas.dataset.compoundGroups = String(state.cy.nodes(".requirement-group").length);
    clearHover();
    updateMajorFitMinimum();
  }

  function ancestors(collection) {
    var result = collection;
    collection.nodes().forEach(function (node) {
      var parent = node.parent();
      while (parent.length) {
        result = result.union(parent);
        parent = parent.parent();
      }
    });
    return result;
  }

  function clearHover() {
    if (!state.cy) return;
    state.cy.elements().removeClass("hover-faded hover-related hover-group-1 hover-group-2 hover-group-3");
    delete elements.graphCanvas.dataset.hoveredCourse;
    delete elements.graphCanvas.dataset.hoverGroupCount;
  }

  function applyHover(node) {
    clearHover();
    if (!state.cy || !node.hasClass("course")) return;
    elements.graphCanvas.dataset.hoveredCourse = node.data("code") || "";
    var prominent = node;
    var visibleEdges = node.connectedEdges().not(".filtered");
    prominent = prominent.union(visibleEdges).union(visibleEdges.connectedNodes());

    if (node.data("code")) {
      var ownedEdges = state.cy.edges().filter(function (edge) {
        return !edge.hasClass("filtered") && edge.data("owner") === node.data("code");
      });
      elements.graphCanvas.dataset.hoverGroupCount = String(new Set(ownedEdges.map(function (edge) {
        return edge.data("hoverGroup");
      })).size);
      prominent = prominent.union(ownedEdges).union(ownedEdges.connectedNodes());
      ownedEdges.forEach(function (edge) {
        var group = ((Number(edge.data("hoverGroup")) - 1) % 3) + 1;
        edge.addClass("hover-group-" + group);
        edge.source().addClass("hover-group-" + group);
      });
    }

    prominent = ancestors(prominent);
    state.cy.elements().not(prominent).addClass("hover-faded");
    prominent.addClass("hover-related");
  }

  function majorFitElements() {
    return state.cy ? state.cy.elements(":visible") : null;
  }

  function majorFitPadding() {
    return state.mobile ? 34 : 64;
  }

  function updateMajorFitMinimum() {
    var visible = majorFitElements();
    if (!visible || !visible.length) return null;
    if (window.GraphInteractionSupport) {
      return window.GraphInteractionSupport.updateFitMinimum(
        state.cy,
        visible,
        majorFitPadding()
      );
    }
    state.cy.fit(visible, majorFitPadding());
    state.cy.minZoom(state.cy.zoom());
    return { zoom: state.cy.zoom(), pan: state.cy.pan() };
  }

  function fitMajorGraph(duration) {
    var visible = majorFitElements();
    if (!visible || !visible.length) return;
    if (window.GraphInteractionSupport) {
      window.GraphInteractionSupport.fitToMinimum(
        state.cy,
        visible,
        majorFitPadding(),
        duration || 0
      );
    } else {
      updateMajorFitMinimum();
    }
  }

  function renderGraph() {
    if (typeof window.cytoscape !== "function") {
      elements.graphEmpty.hidden = false;
      return;
    }
    state.cy = window.cytoscape({
      container: elements.graphCanvas,
      elements: graphElements(),
      style: graphStyles(),
      layout: { name: "preset", fit: false },
      minZoom: 0.01,
      maxZoom: 2.4,
      boxSelectionEnabled: false,
      autoungrabify: true
    });
    applyRelationFilters();
    fitMajorGraph(0);
    var readableZoom = state.mobile ? 0.58 : 0.5;
    if (state.cy.zoom() < readableZoom) {
      var majorRequirements = state.cy.nodes(".major-course, .requirement-summary, .requirement-group");
      state.cy.zoom(readableZoom);
      state.cy.center(majorRequirements);
    }
    state.cy.on("mouseover", "node.course", function (event) { applyHover(event.target); });
    state.cy.on("mouseout", "node.course", clearHover);
    state.cy.on("tap", "node.course", function (event) {
      var node = event.target;
      if (completionHit(node, event.renderedPosition)) {
        event.stopPropagation();
        var code = node.data("code");
        setCourseCompletion(code, !state.completions.has(code));
        node.unselect();
        return;
      }
      openCourse(node.data("code"));
    });
  }

  function relationLabel(relation) {
    return relation === "prerequisite" ? "Prerequisite" : relation === "corequisite" ? "Corequisite" : "Exclusion";
  }

  function fallbackRequirements(item) {
    var byRelation = new Map(item.requirements.map(function (requirement) {
      return [requirement.relation, requirement.raw];
    }));
    return ["prerequisite", "corequisite", "exclusion"].map(function (relation) {
      return { relation: relation, raw: byRelation.get(relation) || "" };
    });
  }

  function renderCourseDrawer(item, detail) {
    var requirements = detail && detail.requirements
      ? ["prerequisite", "corequisite", "exclusion"].map(function (relation) {
          var requirement = detail.requirements[relation];
          return { relation: relation, raw: requirement && (requirement.raw || requirement.raw_text) || "" };
        })
      : fallbackRequirements(item);
    var requirementMarkup = requirements.map(function (requirement) {
      var empty = !requirement.raw;
      return '<section class="requirement-section' + (empty ? " is-empty" : "") + '"><h3><span class="requirement-indicator ' +
        escapeHtml(requirement.relation) + '"></span>' + relationLabel(requirement.relation) +
        '</h3><p>' + escapeHtml(requirement.raw || "None listed") + "</p></section>";
    }).join("");
    var rawCredits = detail && detail.credits != null ? String(detail.credits) : item.credits;
    var creditText = /credit/i.test(rawCredits) ? rawCredits : rawCredits ? rawCredits + " credits" : "";
    var source = detail && (detail.source_url || detail.sourceUrl) || item.source;
    var completed = state.completions.has(item.code);
    elements.drawerContent.innerHTML =
      '<h3 class="details-title">' + escapeHtml(detail && detail.title || item.title) + "</h3>" +
      '<div class="details-meta"><span class="meta-chip">' + escapeHtml(DATA.intake) + " intake</span>" +
      (creditText ? '<span class="meta-chip">' + escapeHtml(creditText) + "</span>" : "") +
      '<span class="meta-chip">' + (item.major ? "Counts toward major" : "Context only") + "</span></div>" +
      '<label class="complete-control"><span>Completed</span><span class="switch"><input id="majorCompletedToggle" type="checkbox" ' +
      (completed ? "checked" : "") + '><span></span></span></label>' +
      requirementMarkup +
      (source ? '<a class="source-link" href="' + escapeHtml(source) + '" target="_blank" rel="noreferrer">Open official course entry</a>' : "");
    var toggle = document.getElementById("majorCompletedToggle");
    if (toggle) {
      toggle.addEventListener("change", function () {
        setCourseCompletion(item.code, toggle.checked);
      });
    }
  }

  async function openCourse(code) {
    var item = courseByCode.get(code);
    if (!item) return;
    elements.drawerSubject.textContent = item.major ? "CPEG major course" : "Relationship context";
    elements.drawerCode.textContent = item.code;
    renderCourseDrawer(item, state.detailCache.get(code));
    openDrawer();
    if (state.detailCache.has(code)) return;
    var requestId = ++state.detailRequest;
    try {
      var detail = window.HKUSTCatalog
        ? await window.HKUSTCatalog.course(CATALOG_YEAR, code)
        : null;
      if (!detail) return;
      state.detailCache.set(code, detail);
      if (requestId === state.detailRequest && elements.drawerCode.textContent === code) {
        renderCourseDrawer(item, detail);
      }
    } catch (_error) {
      // Static PDF/catalog text remains available when the catalog is unavailable.
    }
  }

  function openDrawer() {
    elements.drawer.classList.add("is-open");
    elements.drawer.setAttribute("aria-hidden", "false");
    elements.drawerScrim.hidden = !state.mobile;
  }

  function closeDrawer() {
    elements.drawer.classList.remove("is-open");
    elements.drawer.setAttribute("aria-hidden", "true");
    elements.drawerScrim.hidden = true;
    if (state.cy) state.cy.nodes().unselect();
  }

  function courseButton(code, title, credits) {
    return '<button type="button" data-major-code="' + escapeHtml(code) + '"><span class="major-outline-code">' +
      escapeHtml(code) + '</span><span class="major-outline-title">' + escapeHtml(title) +
      '</span><span class="major-outline-credit">' + escapeHtml(credits) + " cr</span></button>";
  }

  function renderOutline() {
    var fundamentalCodes = ["COMP 1023", "MATH 1013", "MATH 1023", "MATH 1014", "MATH 1024", "MATH 1020", "MATH 2011", "MATH 2111", "PHYS 1112", "PHYS 1312", "PHYS 1114", "PHYS 1314"];
    var requiredCodes = ["CPEG 1930", "CPEG 2930", "CPEG 3930", "COMP 2011", "COMP 2012", "COMP 2012H", "COMP 2611", "ELEC 2350", "COMP 2711", "COMP 2711H", "COMP 3511", "ELEC 1100", "ELEC 2100", "ELEC 2400", "ELEC 2600", "ELEC 3300", "CPEG 1971", "CPEG 4901", "CPEG 4902", "CPEG 4910", "CPEG 4911", "CPEG 4912"];

    function listFor(codes) {
      return '<div class="major-outline-list">' + codes.map(function (code) {
        var item = courseByCode.get(code);
        return courseButton(item.code, item.title, item.credits);
      }).join("") + "</div>";
    }

    elements.outlineContent.innerHTML =
      '<section class="major-outline-section"><header><div><p class="eyebrow">Engineering fundamentals</p><h3>Foundational courses</h3></div><strong>19-21 credits</strong></header>' +
      '<p class="major-rule-copy">Calculus: [(MATH 1013 or MATH 1023) and (MATH 1014 or MATH 1024)] or MATH 1020. Choose one Physics I and one Physics II course.</p>' + listFor(fundamentalCodes) + "</section>" +
      '<section class="major-outline-section"><header><div><p class="eyebrow">Required courses</p><h3>CPEG core</h3></div><strong>42-45 credits</strong></header>' +
      '<p class="major-rule-copy">Complete the standard C++ sequence or COMP 2012H; choose one organization course and one discrete mathematics course. Complete CPEG 1971 with a project/thesis, or CPEG 4910. Students taking the Research Option must take CPEG 4902 or CPEG 4912.</p>' + listFor(requiredCodes) +
      '<a class="source-link" href="' + PROGRAM_SOURCE + '" target="_blank" rel="noreferrer">Open official program catalog</a></section>';
  }

  function setView(view) {
    var graph = view === "graph";
    elements.graphPanel.hidden = !graph;
    elements.outlinePanel.hidden = graph;
    elements.graphTab.classList.toggle("is-active", graph);
    elements.outlineTab.classList.toggle("is-active", !graph);
    elements.graphTab.setAttribute("aria-selected", String(graph));
    elements.outlineTab.setAttribute("aria-selected", String(!graph));
    if (graph && state.cy) {
      state.cy.resize();
      updateMajorFitMinimum();
    }
  }

  function bindEvents() {
    if (window.GraphInteractionSupport) {
      window.GraphInteractionSupport.bindRightDragPan(elements.graphCanvas, function () {
        return state.cy;
      });
    }
    elements.relationInputs.forEach(function (input) { input.addEventListener("change", applyRelationFilters); });
    elements.graphTab.addEventListener("click", function () { setView("graph"); });
    elements.outlineTab.addEventListener("click", function () { setView("outline"); });
    elements.zoomIn.addEventListener("click", function () {
      if (state.cy) state.cy.animate({ zoom: Math.min(2.4, state.cy.zoom() * 1.2), duration: 120 });
    });
    elements.zoomOut.addEventListener("click", function () {
      if (state.cy) state.cy.animate({ zoom: Math.max(state.cy.minZoom(), state.cy.zoom() / 1.2), duration: 120 });
    });
    elements.fit.addEventListener("click", function () {
      fitMajorGraph(180);
    });
    elements.closeDrawer.addEventListener("click", closeDrawer);
    elements.drawerScrim.addEventListener("click", closeDrawer);
    elements.outlineContent.addEventListener("click", function (event) {
      var button = event.target.closest("[data-major-code]");
      if (button) openCourse(button.dataset.majorCode);
    });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeDrawer(); });
    var mobileQuery = window.matchMedia(MOBILE_QUERY);
    mobileQuery.addEventListener("change", function (event) {
      state.mobile = event.matches;
      if (state.cy) {
        state.cy.resize();
        updateMajorFitMinimum();
      }
      if (!state.mobile) elements.drawerScrim.hidden = true;
    });
    window.addEventListener("resize", function () {
      state.mobile = mobileQuery.matches;
      if (state.cy) {
        state.cy.resize();
        updateMajorFitMinimum();
        window.requestAnimationFrame(function () {
          if (!state.cy) return;
          state.cy.resize();
          updateMajorFitMinimum();
        });
      }
    });
  }

  function init() {
    loadCompletions();
    renderOutline();
    bindEvents();
    renderGraph();
  }

  init();
}());
