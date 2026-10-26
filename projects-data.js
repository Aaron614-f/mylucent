// ============================================================
//  myLucent.co — GALLERY PROJECTS
// ============================================================
//  Add a new finished project here and it automatically appears
//  in the homepage gallery (with the right filter tab) and in
//  its own lightbox with every photo for that piece.
//
//  Each project needs:
//    id       - short, no spaces (used internally)
//    title    - shown as the project name
//    tag      - short label shown in the lightbox (e.g. "Simcha Piece")
//    category - MUST be exactly one of: "wall", "book", "simcha"
//               (this controls which filter tab the piece shows under)
//    cover    - path to the main thumbnail photo, shown in the gallery grid
//    photos   - array of ALL photo paths for this project (cover can repeat here)
//
//  Photos should be placed in the /assets folder next to this file.
// ============================================================

window.PROJECTS = [
  {
    id: "simcha-grazing-table",
    title: "Simcha Grazing Table Signage",
    tag: "Simcha Piece",
    category: "simcha",
    cover: "assets/project-01.jpg",
    photos: [
      "assets/project-01.jpg",
      "assets/project-02.jpg"
    ]
  }
];
