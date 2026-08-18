// ============================================================
//  myLucent.co — GALLERY PROJECTS
// ============================================================
//  Add a new finished project here and it automatically appears
//  in the gallery grid and gets its own project page.
//
//  Each project needs:
//    id      - short, no spaces (used in the URL, e.g. project.html?id=simcha-table)
//    title   - shown as the project name
//    tag     - short category label (e.g. "Simcha Piece", "Wall Art")
//    cover   - path to the main thumbnail photo, shown in the gallery grid
//    photos  - array of ALL photo paths for this project (cover can repeat here)
//
//  Photos should be placed in the /assets folder next to this file.
// ============================================================

window.PROJECTS = [
  {
    id: "simcha-grazing-table",
    title: "Simcha Grazing Table Signage",
    tag: "Simcha Piece",
    cover: "assets/project-01.jpg",
    photos: [
      "assets/project-01.jpg",
      "assets/project-02.jpg"
    ]
  }
];
