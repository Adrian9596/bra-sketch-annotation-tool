// Ported from the sibling "Bra construction" project (construction.html) per ADR 0039.
// Verbatim data — do not hand-edit without checking the source stays in sync.

const CONSTRUCTION_TERM_LIBRARY = [
    // Cup & pad
    { en: 'Molded foam cup' },
    { en: 'Molded foam cup – 2 piece' },
    { en: 'Cover foam (molded shell)' },
    { en: 'Set-in cup' },
    { en: 'Cookie – tear drop' },
    { en: 'Cookie (insert pad)' },
    { en: 'Outer cup panel' },
    { en: 'Inner / liner cup' },
    { en: 'Top cup panel' },
    { en: 'Bottom cup panel' },
    { en: 'Sling' },
    { en: 'Undercup' },
    { en: 'Front apex' },
    { en: 'Back apex' },
    { en: 'Adjustable panel' },
    { en: 'Cushion pad' },
    // Cup layer stacks
    { en: 'Cup: allover lace + cover foam + molded foam' },
    { en: 'Cup: galloon lace + shell + molded foam' },
    { en: 'Cup: shell + molded foam (2-layer)' },
    { en: 'Cup: power mesh + cover foam + molded foam' },
    // Body & band
    { en: 'Cradle' },
    { en: 'Center gore (CF bridge)' },
    { en: 'Underband (UB)', aliases: ['UB'] },
    { en: 'Bottom band' },
    { en: 'Back panel – upper' },
    { en: 'Back panel – lower' },
    { en: 'Side panel' },
    { en: 'Center Front (CF)', aliases: ['CF'] },
    { en: 'Center Back (CB)', aliases: ['CB'] },
    { en: 'Neckline' },
    { en: 'Armhole (A/H)', aliases: ['A/H'] },
    // Closures
    { en: 'Guard placket' },
    { en: 'Zipper guard' },
    { en: 'Zipper garage' },
    { en: 'Hook and eye (H&E)', aliases: ['H&E'] },
    { en: 'H&E 4 rows × 4 columns' },
    { en: 'H&E 5 rows × 4 columns' },
    { en: 'H&E 2 rows × 2 columns' },
    { en: 'Open-end zipper' },
    { en: 'Invisible zipper #4' },
    { en: 'Zipper puller' },
    { en: 'Snap button – female 9mm' },
    { en: 'Snap button – male 9mm' },
    { en: 'Velcro patch' },
    // Straps
    { en: 'Shoulder strap' },
    { en: 'Front strap – 2-layer laminated' },
    { en: 'Back strap (elastic)' },
    { en: 'Folded elastic strap' },
    { en: 'Strap elastic with slider' },
    { en: 'Adjustable velcro strap' },
    // Fabrics
    { en: 'Shell fabric' },
    { en: 'Allover lace' },
    { en: 'Galloon lace' },
    { en: 'Power mesh' },
    { en: 'Non-stretch mesh' },
    { en: 'Microfiber mesh' },
    { en: 'Jacquard mesh' },
    { en: 'Satin fabric' },
    { en: 'Thin foam' },
    // Elastics & tapes
    { en: 'UB plush elastic – 1.5cm' },
    { en: 'UB plush elastic – 2cm' },
    { en: 'V-fold elastic' },
    { en: 'Strap elastic – 2cm' },
    { en: 'Strap elastic – 2.5cm' },
    { en: 'Floating elastic tape' },
    { en: 'Rigid tape – 2cm' },
    { en: 'Cotton tape (strap loop)' },
    { en: 'Stretch tape (ready-made)' },
    { en: 'Binding tape – 8mm' },
    { en: 'Wireless casing – 1cm' },
    { en: 'Bonding tape' },
    // Hardware
    { en: '8-shaped ring – 2cm' },
    { en: '8-shaped ring – 2.5cm' },
    { en: 'Slider' },
    { en: 'Swan hook' },
    { en: 'Stabilizer – 6mm' },
    // Stitches & seams
    { en: 'Overlock (O/L)', aliases: ['O/L'] },
    { en: 'Coverstitch' },
    { en: 'Zigzag stitch (ZZ)', aliases: ['ZZ'] },
    { en: '2R zigzag' },
    { en: 'Lockstitch (1NDL / 2NDL)', aliases: ['1NDL', '2NDL', '2NDLS'] },
    { en: 'Flatlock 3NST', aliases: ['3N5T'] },
    { en: 'Topstitch' },
    { en: 'Bartack' },
    { en: 'Double-bartack' },
    { en: 'ZZ bartack' },
    { en: 'Spot tack' },
    { en: 'Flat seam' },
    // Edge finishes
    { en: 'Bagout (clean finish)' },
    { en: 'Inner binding' },
    { en: 'V-fold binding – 8mm' },
    { en: 'V-fold binding – 6mm' },
    { en: 'Self-fold bonded' },
    { en: 'Free-cut / clean-cut edge' },
    { en: 'Side seam – natural placement' },
    { en: 'Side seam – shifted to front' },
    // Forming & bonding
    { en: 'Lamination (2-layer)' },
    { en: 'Molded panel' },
    { en: 'Dot glue bonding' },
    { en: 'Brush glue' },
    { en: 'Heat-press bonding' },
    { en: 'Darted panel' },
    { en: '2-in-1 construction' },
  ];

const CONSTRUCTION_STARTER_PHRASES = [
    {
      id: 'strap-ring-slider',
      category: 'Strap',
      text: 'Adjustable strap with ring and slider',
      aliases: ['adj', 'adjustable', 'strap', 'ring', 'slider', 'strap slider'],
      favorite: true,
    },
    {
      id: 'cup-clean-neckline',
      category: 'Cup',
      text: 'Molded foam cup with clean neckline edge',
      aliases: ['cup', 'molded', 'foam cup', 'clean neckline', 'neckline edge'],
      favorite: true,
    },
    {
      id: 'lace-back-overlock',
      category: 'Lace',
      text: 'Back lace panel joined with overlock seam',
      aliases: ['back lace', 'lace panel', 'overlock', 'over lock', 'ol', 'back panel'],
      favorite: true,
    },
    {
      id: 'underband-lace-cradle-zigzag',
      category: 'Underband',
      text: 'Lace cradle joined to underband with zigzag stitch',
      aliases: ['lace cradle', 'underband', 'under band', 'ub', 'zigzag', 'zig zag', 'zz', 'cradle'],
      favorite: true,
    },
    {
      id: 'neckline-clean-edge',
      category: 'Seam',
      text: 'Clean neckline edge',
      aliases: ['clean', 'neckline', 'neck edge', 'edge finish'],
      favorite: true,
    },
    {
      id: 'underband-zigzag',
      category: 'Underband',
      text: 'Zigzag stitch at underband',
      aliases: ['zigzag', 'zig zag', 'zz', 'underband', 'under band', 'ub stitch'],
      favorite: true,
    },
    {
      id: 'lace-panel-overlock',
      category: 'Lace',
      text: 'Overlock seam at lace panel',
      aliases: ['overlock', 'over lock', 'ol', 'lace', 'lace seam'],
      favorite: true,
    },
    {
      id: 'bartack-reinforcement',
      category: 'Seam',
      text: 'Bartack reinforcement',
      aliases: ['bartack', 'bar tack', 'reinforcement', 'tack'],
      favorite: true,
    },
    {
      id: 'elastic-fold-over-edge',
      category: 'Elastic',
      text: 'Fold-over elastic edge',
      aliases: ['fold over', 'fold-over', 'foe', 'elastic edge', 'elastic'],
      favorite: true,
    },
    {
      id: 'closure-hook-eye',
      category: 'Closure',
      text: 'Hook-and-eye closure',
      aliases: ['hook', 'eye', 'hook eye', 'hook-and-eye', 'h&e', 'h and e', 'closure'],
      favorite: true,
    },
    {
      id: 'wing-power-mesh',
      category: 'Wing',
      text: 'Power mesh wing panel',
      aliases: ['wing', 'power mesh', 'back wing', 'mesh wing'],
      favorite: false,
    },
    {
      id: 'label-care',
      category: 'Label',
      text: 'Care label at inner wing',
      aliases: ['label', 'care label', 'inner wing', 'brand label'],
      favorite: false,
    },
    {
      id: 'closure-front-zipper',
      category: 'Closure',
      text: 'Front zipper with inner zipper guard',
      aliases: ['zipper', 'front closure', 'zip guard', 'zipper guard'],
      favorite: false,
    },
    {
      id: 'strap-bartack',
      category: 'Strap',
      text: 'Strap attached with double bartack',
      aliases: ['strap bartack', 'double bartack', 'strap attach'],
      favorite: false,
    },
    {
      id: 'cup-lace-overlay',
      category: 'Cup',
      text: 'Lace overlay on molded foam cup',
      aliases: ['lace overlay', 'cup lace', 'foam cup lace', 'overlay cup'],
      favorite: false,
    },
    {
      id: 'seam-topstitch',
      category: 'Seam',
      text: 'Topstitch along seam allowance',
      aliases: ['topstitch', 'seam allowance', 'stitch seam'],
      favorite: false,
    },
  ];

const CONSTRUCTION_GENERATED_PHRASES = [
    {
        "category": "Strap",
        "text": "2R Bartack attach front strap w/ back elastic strap",
        "aliases": [
            "strap",
            "elastic",
            "bartack",
            "front",
            "back",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Strap",
        "text": "Adjustable back strap with 8 - shaped ring & slider",
        "aliases": [
            "strap",
            "ring",
            "hardware",
            "slider",
            "back",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Adjustable elastic straps with 8 shape ring - 2cm to 2.5cm",
        "aliases": [
            "strap",
            "ring",
            "hardware",
            "elastic",
            "2cm",
            "5cm",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Strap",
        "text": "Adjustable strap with velcro & 8 - shaped ring",
        "aliases": [
            "strap",
            "ring",
            "hardware",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Adjustable strap with velcro & 8 - shaped ring Double - bartack",
        "aliases": [
            "strap",
            "ring",
            "hardware",
            "bartack",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Strap",
        "text": "Distance from center of 1st snap to strap joint: 1 cm 1 cm",
        "aliases": [
            "strap",
            "snap",
            "snap button",
            "hardware",
            "1cm",
            "1 cm",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Double layer shell fabric laminated at front strap. Attached to velcro by V - fold (5mm folded width contrast color) - 1NDL top stitch Strap width: 2cm for all sizes",
        "aliases": [
            "strap",
            "shell fabric",
            "fabric",
            "1ndl",
            "topstitch",
            "laminated",
            "lamination",
            "folded width",
            "width",
            "5mm",
            "2cm",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Strap",
        "text": "Double layer shell fabric laminated at front strap. Attached to velcro by V - fold (5mm folded width) 1NDL top stitch Strap width: 2cm for all sizes",
        "aliases": [
            "strap",
            "shell fabric",
            "fabric",
            "1ndl",
            "topstitch",
            "laminated",
            "lamination",
            "folded width",
            "width",
            "5mm",
            "2cm",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf; KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Strap",
        "text": "Elastic strap attached to back panel by double - bartack Double - layered cup panel Outer: Molded shell cup (One - piece) Inner: Molded foam cup (Two - piece)",
        "aliases": [
            "strap",
            "cup",
            "back panel",
            "back",
            "elastic",
            "molded foam",
            "foam cup",
            "bartack",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Folded elastic strap attached to back panel by double - bartack",
        "aliases": [
            "strap",
            "back panel",
            "back",
            "elastic",
            "bartack",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Front & back strap attached together by clean finish",
        "aliases": [
            "strap",
            "front",
            "back",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Front apex self fold with zigzag stitch to create loop",
        "aliases": [
            "strap",
            "zigzag",
            "zz",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Strap",
        "text": "Front strap continue from front to back",
        "aliases": [
            "strap",
            "front",
            "back",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Strap",
        "text": "front UB outer, Back panel, outer strap zipper guard",
        "aliases": [
            "strap",
            "ub",
            "underband",
            "back panel",
            "back",
            "zipper",
            "closure",
            "front",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Strap",
        "text": "Inner foam cup & shell cup bagout at upper edgeclean finish. (This edge floating) Front apex self fold with zigzag stitch to create loop Two - piece molded foam cup attached together at CF by stabilizer",
        "aliases": [
            "strap",
            "cup",
            "cf",
            "center front",
            "molded foam",
            "foam cup",
            "zigzag",
            "zz",
            "bagout",
            "clean finish",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Loop elastic strap construction with swan hook & 8 - shaped ring adjuster Number of loops: 15 loops for all sizes Strap width: XS - XL= 2cm 2XL - above = 2.5cm",
        "aliases": [
            "strap",
            "hook - and - eye",
            "h & e",
            "closure",
            "ring",
            "hardware",
            "swan hook",
            "elastic",
            "width",
            "2cm",
            "5cm",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Loops on front strap",
        "aliases": [
            "strap",
            "front",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Strap",
        "text": "Nylon coated swan hook (front strap)",
        "aliases": [
            "strap",
            "hook - and - eye",
            "h & e",
            "closure",
            "swan hook",
            "hardware",
            "front",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Strap",
        "text": "Shoulder strap in 2 layers: Outer: Shell fabric Liner: Power mesh 8 shape ring at the end of the strap (Inner width XS - XL: 2.5cm 2XL and above: 3cm",
        "aliases": [
            "strap",
            "ring",
            "hardware",
            "power mesh",
            "mesh",
            "shell fabric",
            "fabric",
            "width",
            "5cm",
            "3cm",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Shoulder Strap panel length",
        "aliases": [
            "strap",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Strap",
        "text": "Side panel continue to strap",
        "aliases": [
            "strap",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Snap button (female side) attached to strap elastic - 1NDL topstitch Diameter: 1 cm all sizes Number of snap (female): 2",
        "aliases": [
            "strap",
            "snap",
            "snap button",
            "hardware",
            "elastic",
            "1ndl",
            "topstitch",
            "1cm",
            "1 cm",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Strap construction: Rigid tape (as overlaid on top strap elastic with bartack to create loops 6 loops. 1cm/loops Hook at 2nd loop",
        "aliases": [
            "strap",
            "hook - and - eye",
            "h & e",
            "closure",
            "elastic",
            "tape",
            "bartack",
            "1cm",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Strap",
        "text": "Strap elastic with slider attached to cushion pad - edgestitch vertical bartack at cushion pad end Width: 2 cm all sizes 8 - shaped ring attached at back apex - self - folded and bartack to create loop",
        "aliases": [
            "strap",
            "ring",
            "hardware",
            "slider",
            "elastic",
            "cushion pad",
            "pad",
            "bartack",
            "width",
            "2cm",
            "2 cm",
            "back",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Strap panel attached to cup panel by double bartack",
        "aliases": [
            "strap",
            "cup",
            "bartack",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Strap",
        "text": "Strap Width at Shoulder seam",
        "aliases": [
            "strap",
            "width",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Strap",
        "text": "Straps (cushion pad and strap elastic) attached inner front cup panel at front apex - O/L, bartack at front apex Strap width: 3.5 cm all sizes",
        "aliases": [
            "strap",
            "cup",
            "elastic",
            "cushion pad",
            "pad",
            "bartack",
            "overlock",
            "o/l",
            "ol",
            "width",
            "5cm",
            "5 cm",
            "front",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "Two layers at cushion pad - laminated 1st layer: Shell fabric 2nd layer: Thin foam",
        "aliases": [
            "strap",
            "shell fabric",
            "fabric",
            "cushion pad",
            "pad",
            "laminated",
            "lamination",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Strap",
        "text": "V - fold binding w/ Coverstitch along strap edges",
        "aliases": [
            "strap",
            "binding",
            "binding tape",
            "coverstitch",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Strap",
        "text": "V - fold elastic all around cushion pad - coverstitch Folded width: 6 mm all sizes",
        "aliases": [
            "strap",
            "elastic",
            "cushion pad",
            "pad",
            "coverstitch",
            "folded width",
            "width",
            "6mm",
            "6 mm",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Clean finish - middle shell with cup at neckline",
        "aliases": [
            "cup",
            "neckline",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Cup",
        "text": "Cup construction: Outer - molded shell fabric Liner - set in cup attached to mesh by flat seam",
        "aliases": [
            "cup",
            "shell fabric",
            "fabric",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Cup construction: Outer layer: Darted galloon lace with ZZ on top lowest scallop Middle layer: Molded shell Liner: Molded foam cup/2 pieces",
        "aliases": [
            "cup",
            "lace",
            "galloon lace",
            "molded foam",
            "foam cup",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Cup",
        "text": "Cup construction: Outer layer: Molded shell Liner: Molded foam cup/2 pieces",
        "aliases": [
            "cup",
            "molded foam",
            "foam cup",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Cup",
        "text": "Cup in single layer molded shell fabric Overlaid on inner set in foam cup",
        "aliases": [
            "cup",
            "shell fabric",
            "fabric",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Cup in single layer of molded shell fabric overlaid on molded foam cup",
        "aliases": [
            "cup",
            "shell fabric",
            "fabric",
            "molded foam",
            "foam cup",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Cup Panel height at Center Front",
        "aliases": [
            "cup",
            "center front",
            "cf",
            "front",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Cup",
        "text": "Double layer at cup panel: 1st: Molded shell fabric 2nd: Molded foam cup Double layered UB panel: Outer: Shell Fabric (Synthetic) Inner: Power Mesh",
        "aliases": [
            "cup",
            "ub",
            "underband",
            "power mesh",
            "mesh",
            "shell fabric",
            "fabric",
            "molded foam",
            "foam cup",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Foam cup +shell at front neckline bagout - clean finish",
        "aliases": [
            "cup",
            "neckline",
            "bagout",
            "clean finish",
            "front",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Foam cups joined together with stabilizer (2NDLS lockstitch) at inner CF",
        "aliases": [
            "cup",
            "cf",
            "center front",
            "2ndls",
            "lockstitch",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Cup",
        "text": "front cup middle",
        "aliases": [
            "cup",
            "front",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Cup",
        "text": "Front Neckline cup panel bagout - clean finish",
        "aliases": [
            "cup",
            "neckline",
            "bagout",
            "clean finish",
            "front",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Full panel power mesh at inner UB, attached to foam cup by flatlock 3N5T",
        "aliases": [
            "cup",
            "ub",
            "underband",
            "power mesh",
            "mesh",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf; KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Cup",
        "text": "Inner binding at under cup seam + side seam 2NDLS lockstitch",
        "aliases": [
            "cup",
            "side seam",
            "binding",
            "binding tape",
            "2ndls",
            "lockstitch",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Inner binding by stabilizer to join 2 piece cup Inner cup binding with 2NDLS lockstitch",
        "aliases": [
            "cup",
            "binding",
            "binding tape",
            "2ndls",
            "lockstitch",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Cup",
        "text": "Inner binding tape at under cup and side seam - 2NDLS stitch Width: 1 cm all sizes",
        "aliases": [
            "cup",
            "side seam",
            "binding",
            "binding tape",
            "tape",
            "2ndls",
            "lockstitch",
            "width",
            "1cm",
            "1 cm",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Inner cup binding at Under cup seam + inner side seam - 2NDLS lockstitch",
        "aliases": [
            "cup",
            "side seam",
            "binding",
            "binding tape",
            "2ndls",
            "lockstitch",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Inner cup binding with 2NDLS lockstitch",
        "aliases": [
            "cup",
            "binding",
            "binding tape",
            "2ndls",
            "lockstitch",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Inner foam cup & shell cup attached to inner power mesh by flatlock 3N5T Inner neckline piece attached together at CF by O/LClean finish",
        "aliases": [
            "cup",
            "neckline",
            "cf",
            "center front",
            "power mesh",
            "mesh",
            "overlock",
            "o/l",
            "ol",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Cup",
        "text": "Lace trim overlaid on cup seam attach by zigzag stitch",
        "aliases": [
            "cup",
            "lace",
            "zigzag",
            "zz",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Molded fixed cup - 2 piece",
        "aliases": [
            "cup",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Cup",
        "text": "Molded foam cup",
        "aliases": [
            "cup",
            "molded foam",
            "foam cup",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "natural placement Satin piping at front side panel and top cup (width - 4mm at outer Encased elastic at UB continue view) from front to back (3cm - for all Front Back",
        "aliases": [
            "cup",
            "lace",
            "ub",
            "underband",
            "elastic",
            "width",
            "4mm",
            "3cm",
            "front",
            "back",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Neckline in single layer of microfiber with small elastic in 6mm along neckline edge attach by zigzag stitch Neckline panel attach with cup panel by inner binding along neckline foam",
        "aliases": [
            "cup",
            "neckline",
            "elastic",
            "binding",
            "binding tape",
            "zigzag",
            "zz",
            "6mm",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "OL attach singel - layer of power mesh with shell, ZZ attach OL seam to inner molded foam cup Shell fabric Foam cup",
        "aliases": [
            "cup",
            "power mesh",
            "mesh",
            "shell fabric",
            "fabric",
            "molded foam",
            "foam cup",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Cup",
        "text": "Outer Cup height",
        "aliases": [
            "cup",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Cup",
        "text": "Outer cup width",
        "aliases": [
            "cup",
            "width",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Cup",
        "text": "Outer front cup",
        "aliases": [
            "cup",
            "front",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Cup",
        "text": "Outer shell 2 - Alloverlace Outer cup",
        "aliases": [
            "cup",
            "lace",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Cup",
        "text": "Ready made soft tape along foam cup and neckline attach by 2NDLS",
        "aliases": [
            "cup",
            "neckline",
            "tape",
            "2ndls",
            "lockstitch",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Ready made soft tape along under cup and neckline attach by 2 needle stitch",
        "aliases": [
            "cup",
            "neckline",
            "tape",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Set in cup Power mesh liner end at foam cup attach with foam cup by flat seam",
        "aliases": [
            "cup",
            "power mesh",
            "mesh",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Shell cup attached with foam cup by 1NDL - lockstitch at armhole, then outer lace will O/L & bagout - clean finish",
        "aliases": [
            "cup",
            "lace",
            "armhole",
            "a/h",
            "overlock",
            "o/l",
            "ol",
            "1ndl",
            "topstitch",
            "bagout",
            "clean finish",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Shell cup attached with foam cup by 1NDL - lockstitch at armhole, then outer mesh will O/L & bagout - clean finish",
        "aliases": [
            "cup",
            "armhole",
            "a/h",
            "overlock",
            "o/l",
            "ol",
            "1ndl",
            "topstitch",
            "bagout",
            "clean finish",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Single - layered molded power mesh front cup panel Clean finished at molded foam cup neckline and armhole O/L and bagout",
        "aliases": [
            "cup",
            "neckline",
            "armhole",
            "a/h",
            "power mesh",
            "mesh",
            "molded foam",
            "foam cup",
            "overlock",
            "o/l",
            "ol",
            "bagout",
            "clean finish",
            "front",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Spot tacks attach lace to cup panel",
        "aliases": [
            "cup",
            "lace",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Stabilizer at CF inner cup attach by 2NDLS stitch",
        "aliases": [
            "cup",
            "cf",
            "center front",
            "2ndls",
            "lockstitch",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Stabilizer attached to inner molded cup at CF with 2NDLS stabilizer width = 6mm all sizes",
        "aliases": [
            "cup",
            "cf",
            "center front",
            "2ndls",
            "lockstitch",
            "width",
            "6mm",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Cup",
        "text": "Three layer at cup panel: 1st: Molded galloon lace 2nd: Molded shell fabric 3rd: Molded foam cup",
        "aliases": [
            "cup",
            "lace",
            "galloon lace",
            "shell fabric",
            "fabric",
            "molded foam",
            "foam cup",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Three layer at front cup: 1st: Molded allover lace 2nd: One panel molded shell (cover foam) 3rd: Molded foam cup Non - stretch mesh at outer front keyhole, attached to outer shell UB by O/L - 1NDL top stitch",
        "aliases": [
            "cup",
            "lace",
            "ub",
            "underband",
            "molded foam",
            "foam cup",
            "overlock",
            "o/l",
            "ol",
            "1ndl",
            "topstitch",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Three layer at front cup: 1st: Molded power mesh 2nd: One panel molded contrast fabric (cover foam cup) 3rd: Set - in molded foam cup",
        "aliases": [
            "cup",
            "power mesh",
            "mesh",
            "molded foam",
            "foam cup",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Cup",
        "text": "Three layer at front cup: 1st: Molded power mesh 2nd: One panel molded shell (cover foam) 3rd: Molded foam cup Non - stretch mesh at outer front keyhole, attached to outer shell UB by O/L - 1NDL top stitch",
        "aliases": [
            "cup",
            "ub",
            "underband",
            "power mesh",
            "mesh",
            "molded foam",
            "foam cup",
            "overlock",
            "o/l",
            "ol",
            "1ndl",
            "topstitch",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Three layer at front cup: 1st: Molded power mesh 2nd: One panel molded Shell fabric (cover foam cup) 3rd: Set - in molded foam cup",
        "aliases": [
            "cup",
            "power mesh",
            "mesh",
            "shell fabric",
            "fabric",
            "molded foam",
            "foam cup",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Cup",
        "text": "Three layers at sling (only attached to CF under cup and side seam) 1st layer: Molded allover lace 2nd layer: Molded shell fabric (synthetic) 3rd layer: Molded foam cup",
        "aliases": [
            "cup",
            "sling",
            "lace",
            "side seam",
            "cf",
            "center front",
            "shell fabric",
            "fabric",
            "molded foam",
            "foam cup",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Top cup panel in 1 layer jacquard mesh attach to shell/cup bottom piece with piping between by O/L and top stitch",
        "aliases": [
            "cup",
            "overlock",
            "o/l",
            "ol",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Two - piece molded foam cup",
        "aliases": [
            "cup",
            "molded foam",
            "foam cup",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf; TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Two - piece molded foam cup attached together at CF by stabilizer - 2NDLS lock stitch",
        "aliases": [
            "cup",
            "cf",
            "center front",
            "molded foam",
            "foam cup",
            "2ndls",
            "lockstitch",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Cup",
        "text": "Two - pieces molded foam cup",
        "aliases": [
            "cup",
            "molded foam",
            "foam cup",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Two layers at sling (only attached to CF under cup and side seam) 1st layer: Molded shell fabric (synthetic) 2nd layer: Molded foam cup",
        "aliases": [
            "cup",
            "sling",
            "side seam",
            "cf",
            "center front",
            "shell fabric",
            "fabric",
            "molded foam",
            "foam cup",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "under cup outer binding",
        "aliases": [
            "cup",
            "binding",
            "binding tape",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Cup",
        "text": "V - fold binding w/ Coverstitch along neckline & A/H of cup panel",
        "aliases": [
            "cup",
            "neckline",
            "binding",
            "binding tape",
            "coverstitch",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Cup",
        "text": "V - fold elastic at front & back neckline front & back armhole of inner front cup panel - coverstitch Folded width: 1 cm all sizes",
        "aliases": [
            "cup",
            "neckline",
            "armhole",
            "a/h",
            "elastic",
            "coverstitch",
            "folded width",
            "width",
            "1cm",
            "1 cm",
            "front",
            "back",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Cup",
        "text": "Wireless Casing 1 cm all sizes Glue Brush glue Glue Outer cup",
        "aliases": [
            "cup",
            "1cm",
            "1 cm",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Sling",
        "text": "Double - layered at outer sling: Outer: Galloon lace Liner: Power mesh",
        "aliases": [
            "sling",
            "lace",
            "galloon lace",
            "power mesh",
            "mesh",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Sling",
        "text": "Double - layered at outer sling: Outer: Shell fabric Liner: Power mesh",
        "aliases": [
            "sling",
            "power mesh",
            "mesh",
            "shell fabric",
            "fabric",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Sling",
        "text": "Sling edges finished by inner mobilon tape (6mm) - zigzag stitch",
        "aliases": [
            "sling",
            "tape",
            "zigzag",
            "zz",
            "6mm",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Sling",
        "text": "Sling: One layer of molded shell fabric free cut at AH and neckline edge",
        "aliases": [
            "sling",
            "neckline",
            "shell fabric",
            "fabric",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Sling",
        "text": "Snap button (male side) with folded rigid tape to cover sling apex - 1NDL topstitch all around rigid tape Diameter: 1 cm all sizes Number of snap (male): 1",
        "aliases": [
            "sling",
            "snap",
            "snap button",
            "hardware",
            "tape",
            "1ndl",
            "topstitch",
            "1cm",
            "1 cm",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Lace",
        "text": "Allover lace layer attached to outer shell UB by outer binding - 2NDLS lock stitch",
        "aliases": [
            "lace",
            "ub",
            "underband",
            "binding",
            "binding tape",
            "2ndls",
            "lockstitch",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf"
    },
    {
        "category": "Lace",
        "text": "Back panel in 1 layer shell with lace panel on top attached by ZZ",
        "aliases": [
            "lace",
            "back panel",
            "back",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Lace",
        "text": "Contrast fabric (Under lace)",
        "aliases": [
            "lace",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Lace",
        "text": "Inner plush elastic at back hem placed on bonding area",
        "aliases": [
            "lace",
            "elastic",
            "back",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Lace",
        "text": "Loop elastic attached to left lace with double bartacks; elastic passes through an 8 - shaped ring on right side & looped onto itself with a swan hook",
        "aliases": [
            "lace",
            "hook - and - eye",
            "h & e",
            "closure",
            "ring",
            "hardware",
            "swan hook",
            "elastic",
            "bartack",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Lace",
        "text": "Outer lace layer attached together at CF by O/L. Topstitch + bartack on WL side",
        "aliases": [
            "lace",
            "cf",
            "center front",
            "bartack",
            "overlock",
            "o/l",
            "ol",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf"
    },
    {
        "category": "Lace",
        "text": "Shell fabric and lace are approved",
        "aliases": [
            "lace",
            "shell fabric",
            "fabric",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Lace",
        "text": "side seam at natural placement",
        "aliases": [
            "lace",
            "side seam",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Lace",
        "text": "side seam at natural placement Finished with inner binding",
        "aliases": [
            "lace",
            "side seam",
            "binding",
            "binding tape",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf; KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Lace",
        "text": "side seam at natural placement Inner binding side seam",
        "aliases": [
            "lace",
            "side seam",
            "binding",
            "binding tape",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Lace",
        "text": "Side seam shifted to front Two layers at top back panel: Outer: Allover lace Liner: Power mesh",
        "aliases": [
            "lace",
            "side seam",
            "back panel",
            "back",
            "power mesh",
            "mesh",
            "front",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Lace",
        "text": "Side Seam: Natural Placement Cradle hem: 1cm self - fold bonded",
        "aliases": [
            "lace",
            "side seam",
            "1cm",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Lace",
        "text": "Technical Detail Sheet - Lace version Outer Construction",
        "aliases": [
            "lace",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Underband",
        "text": "1cm shell self fold at inner UB",
        "aliases": [
            "underband",
            "ub",
            "1cm",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Underband",
        "text": "Bartack at UB binding end",
        "aliases": [
            "underband",
            "ub",
            "binding",
            "binding tape",
            "bartack",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Underband",
        "text": "Double - layered at front UB: Outer: Shell fabric Liner: Power mesh",
        "aliases": [
            "underband",
            "ub",
            "power mesh",
            "mesh",
            "shell fabric",
            "fabric",
            "front",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Underband",
        "text": "Double layered UB panel: Outer: Shell Fabric (Synthetic) Inner: Power Mesh Center gore O/L + bagout 1NDL topstitch at inner mesh",
        "aliases": [
            "underband",
            "ub",
            "power mesh",
            "mesh",
            "shell fabric",
            "fabric",
            "overlock",
            "o/l",
            "ol",
            "1ndl",
            "topstitch",
            "bagout",
            "clean finish",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Underband",
        "text": "Inner binding to attach Plush elastic along front and back UB zipper and zipper guard Inner left side seam opening hem attach by zigzag stitch open end zipper with laminated zipper XS - XL 1.5cm guard 2XL and above - 2cm",
        "aliases": [
            "underband",
            "ub",
            "side seam",
            "zipper",
            "closure",
            "elastic",
            "binding",
            "binding tape",
            "zigzag",
            "zz",
            "laminated",
            "lamination",
            "5cm",
            "2cm",
            "front",
            "back",
            "open end",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Underband",
        "text": "Inner plush elastic at Front + Back UB, attached with zigzag stitch XS - XL: 1.5cm 2XL - above: 2cm",
        "aliases": [
            "underband",
            "ub",
            "elastic",
            "zigzag",
            "zz",
            "5cm",
            "2cm",
            "front",
            "back",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf; KiraForm/KiraForm-vB-1.0.pdf; KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Underband",
        "text": "Inner plush elastic at UB Elastic height: 1.5cm for all sizes",
        "aliases": [
            "underband",
            "ub",
            "elastic",
            "5cm",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Underband",
        "text": "Laser - cut holes on outer front shell UB Power mesh panel attached to outer shell UB by inner binding - 2NDLS lock stitch",
        "aliases": [
            "underband",
            "ub",
            "binding",
            "binding tape",
            "power mesh",
            "mesh",
            "2ndls",
            "lockstitch",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Underband",
        "text": "Please increase the back underband to 2 cm, in line with the default sample, for better support, while reducing the center back side to 2 cm only",
        "aliases": [
            "underband",
            "ub",
            "2cm",
            "2 cm",
            "back",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Underband",
        "text": "Plush elastic along front and back UB hem attach by zigzag stitch Elastic in 1.5 cm for XS - XL 2XL and above: 2cm",
        "aliases": [
            "underband",
            "ub",
            "elastic",
            "zigzag",
            "zz",
            "5cm",
            "5 cm",
            "2cm",
            "front",
            "back",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Underband",
        "text": "Power mesh layer attached to outer shell UB by outer binding - 2NDLS lock stitch",
        "aliases": [
            "underband",
            "ub",
            "binding",
            "binding tape",
            "power mesh",
            "mesh",
            "2ndls",
            "lockstitch",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf"
    },
    {
        "category": "Underband",
        "text": "Sample fitted and below are the comments accordingly Overall fit is good. The front underband is loose. Please reduce the front underband length by 1\" in total The shape should be maintained as per the default sample (Image 2)",
        "aliases": [
            "underband",
            "ub",
            "front",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Underband",
        "text": "UB has double layer of shell fabric self folded bonding together by dot glue, at CF of UB there is a heat press artwork (same technic as Armourlift but in diferrent shape)",
        "aliases": [
            "underband",
            "ub",
            "cf",
            "center front",
            "shell fabric",
            "fabric",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Underband",
        "text": "UB plush elastic",
        "aliases": [
            "underband",
            "ub",
            "elastic",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf; SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Underband",
        "text": "UB plush elastic at front & back - zigzag stitch Width: XS - XL: 1.5 cm 2XL and above: 2 cm",
        "aliases": [
            "underband",
            "ub",
            "elastic",
            "zigzag",
            "zz",
            "width",
            "5cm",
            "5 cm",
            "2cm",
            "2 cm",
            "front",
            "back",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Neckline",
        "text": "1cm inner plush elastic with ZZ stitch at AH and back neckline",
        "aliases": [
            "neckline",
            "elastic",
            "1cm",
            "back",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Neckline",
        "text": "Center front neckline drop*",
        "aliases": [
            "neckline",
            "center front",
            "cf",
            "front",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Neckline",
        "text": "Inner elastic (1cm) at armhole & neckline - zigzag stitch",
        "aliases": [
            "neckline",
            "armhole",
            "a/h",
            "elastic",
            "zigzag",
            "zz",
            "1cm",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Neckline",
        "text": "Inner plush elastic at armhole & back neckline - zigzag stitch 6mm width for all sizes",
        "aliases": [
            "neckline",
            "armhole",
            "a/h",
            "elastic",
            "zigzag",
            "zz",
            "width",
            "6mm",
            "back",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Neckline",
        "text": "Neckline & armholes finish",
        "aliases": [
            "neckline",
            "armhole",
            "a/h",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Neckline",
        "text": "V - fold binding at front neckline armhole, back neckline - coverstitch 8mm folded width for all sizes",
        "aliases": [
            "neckline",
            "armhole",
            "a/h",
            "binding",
            "binding tape",
            "coverstitch",
            "folded width",
            "width",
            "8mm",
            "front",
            "back",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf; KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Neckline",
        "text": "V - fold binding at front neckline armhole, back neckline - coverstitch 8mm folded width for all sizes V - fold binding in contrast color",
        "aliases": [
            "neckline",
            "armhole",
            "a/h",
            "binding",
            "binding tape",
            "coverstitch",
            "folded width",
            "width",
            "8mm",
            "front",
            "back",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Neckline",
        "text": "V - fold binding attach by zz stitch (8mm fold width) along neckline and A/H",
        "aliases": [
            "neckline",
            "binding",
            "binding tape",
            "width",
            "8mm",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Neckline",
        "text": "V - fold binding w/ Coverstitch along neckline & A/H of adjustable panel; continues to A/H of cradle and back panel",
        "aliases": [
            "neckline",
            "back panel",
            "back",
            "binding",
            "binding tape",
            "coverstitch",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Armhole",
        "text": "Inner elastic (1cm) at armholezigzag stitch",
        "aliases": [
            "armhole",
            "a/h",
            "elastic",
            "zigzag",
            "zz",
            "1cm",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "Binding side seam move to the front",
        "aliases": [
            "side seam",
            "binding",
            "binding tape",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "Eyes side attach with side seam binding",
        "aliases": [
            "side seam",
            "binding",
            "binding tape",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "Inner right side seam have H & E opening 1 column, 3 rows (6cm height customize H & E)",
        "aliases": [
            "side seam",
            "6cm",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "LEFT side seam OPENING",
        "aliases": [
            "side seam",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "One side of the zipper tape attach with side seam binding",
        "aliases": [
            "side seam",
            "zipper",
            "closure",
            "binding",
            "binding tape",
            "tape",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "RIGHT side seam OPENING Loops side attach with front panel",
        "aliases": [
            "side seam",
            "front panel",
            "front",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "Side seam length",
        "aliases": [
            "side seam",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Side Seam",
        "text": "Side seam shifted to",
        "aliases": [
            "side seam",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf; TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "Side seam shifted to front",
        "aliases": [
            "side seam",
            "front",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Side Seam",
        "text": "Side seam shifted to front Double - layered power mesh top back panel",
        "aliases": [
            "side seam",
            "back panel",
            "back",
            "power mesh",
            "mesh",
            "front",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "(with zipper guard)",
        "aliases": [
            "closure",
            "zipper",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "(without zipper guard for easier visualization)",
        "aliases": [
            "closure",
            "zipper",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "1/2 Bottom band (closest hook) - relax",
        "aliases": [
            "closure",
            "hook - and - eye",
            "h & e",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Closure",
        "text": "Another side of zipper tape attach by binding and bartack at top and bottom end 6cm",
        "aliases": [
            "closure",
            "zipper",
            "binding",
            "binding tape",
            "tape",
            "bartack",
            "6cm",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Back closure with H & E 4 rows, 4 columns for S - XL 5 rows, 4 columns for 2XL - above",
        "aliases": [
            "closure",
            "back closure",
            "back",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Back closure with H & E: 4 rows, 4 columns for all sizes",
        "aliases": [
            "closure",
            "back closure",
            "back",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf; KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Closure",
        "text": "Binding tape at front closure - 2NDLS stitch, self - folded with bartacks at 2 ends Width: 8 mm all sizes",
        "aliases": [
            "closure",
            "front closure",
            "cf",
            "binding",
            "binding tape",
            "tape",
            "bartack",
            "2ndls",
            "lockstitch",
            "width",
            "8mm",
            "8 mm",
            "front",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Center Back Height (Hook - and - eye)",
        "aliases": [
            "closure",
            "hook - and - eye",
            "h & e",
            "back",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Closure",
        "text": "Double - layered shell fabric guard placket (no garage) - laminated Width: 3 cm all sizes",
        "aliases": [
            "closure",
            "placket",
            "shell fabric",
            "fabric",
            "laminated",
            "lamination",
            "width",
            "3cm",
            "3 cm",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Front closure with H & E 2 rows, 2 columns for all sizes",
        "aliases": [
            "closure",
            "front closure",
            "cf",
            "front",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Front closure with invisible open end zipper (#4) with puller",
        "aliases": [
            "closure",
            "front closure",
            "cf",
            "zipper",
            "front",
            "open end",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Closure",
        "text": "H & E closure 4 rows, 4 columns for all sizes",
        "aliases": [
            "closure",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Closure",
        "text": "Hook and eye",
        "aliases": [
            "closure",
            "hook - and - eye",
            "h & e",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Closure",
        "text": "Inner elastic loop with swan hook - 1cm",
        "aliases": [
            "closure",
            "hook - and - eye",
            "h & e",
            "swan hook",
            "hardware",
            "elastic",
            "1cm",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Laminated fabric as zipper guard",
        "aliases": [
            "closure",
            "zipper",
            "laminated",
            "lamination",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Nylon coated swan hook (placket inner loop)",
        "aliases": [
            "closure",
            "hook - and - eye",
            "h & e",
            "swan hook",
            "hardware",
            "placket",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Closure",
        "text": "Open end zipper at the CF with zipper guard on the inside, continued out as a zipper garage (laminated) at the top & bottom",
        "aliases": [
            "closure",
            "cf",
            "center front",
            "zipper",
            "laminated",
            "lamination",
            "open end",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Self - fold w/ bartack create loop to hold swan hook Rigid tape w/ bartacks create 3 loops for swan hook",
        "aliases": [
            "closure",
            "hook - and - eye",
            "h & e",
            "swan hook",
            "hardware",
            "tape",
            "bartack",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Closure",
        "text": "Single layered shell fabric at back panel Back closure with H & E 5 rows, 4 column for all sizes",
        "aliases": [
            "closure",
            "back panel",
            "back",
            "back closure",
            "shell fabric",
            "fabric",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Zipper guard - double layered fabric laminated continued as zipper garage at the top & bottom",
        "aliases": [
            "closure",
            "zipper",
            "laminated",
            "lamination",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Closure",
        "text": "Zipper guard on the inside, continued out as a zipper garage at the top & bottom edges",
        "aliases": [
            "closure",
            "zipper",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Elastic",
        "text": "5 loops for all sizes, 1cm each loop Elastic width: 2cm full sizes",
        "aliases": [
            "elastic",
            "width",
            "1cm",
            "2cm",
            "feliciabra"
        ],
        "source": "FeliciaBra/FeliciaBra-vB-3.0.pdf"
    },
    {
        "category": "Elastic",
        "text": "Bar tacks BIGGER SIZE: add loops and elastic",
        "aliases": [
            "elastic",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Elastic",
        "text": "Chanel plush tape (inside)",
        "aliases": [
            "elastic",
            "tape",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Elastic",
        "text": "Fusing (inside) V - fold elastic",
        "aliases": [
            "elastic",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Elastic",
        "text": "H & E Chanel plush tape",
        "aliases": [
            "elastic",
            "tape",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Elastic",
        "text": "Inner elastic loop",
        "aliases": [
            "elastic",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Elastic",
        "text": "Inner plush elastic at back panel attached by ZZ - 1.5cm to 2cm",
        "aliases": [
            "elastic",
            "back panel",
            "back",
            "5cm",
            "2cm",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Elastic",
        "text": "Light weight elastic inner loops",
        "aliases": [
            "elastic",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Elastic",
        "text": "Opening for elastic tape insertion, elastic continues H & E edge (inner view) Shell fabric lap bonded 1cm on inner side",
        "aliases": [
            "elastic",
            "tape",
            "shell fabric",
            "fabric",
            "1cm",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Elastic",
        "text": "V - fold elastic",
        "aliases": [
            "elastic",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf; SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Binding",
        "text": "2NDLS stitch at outer binding will sew through inner mesh",
        "aliases": [
            "binding",
            "binding tape",
            "2ndls",
            "lockstitch",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf"
    },
    {
        "category": "Binding",
        "text": "CB panel in single layer of power mesh Under: 2 shell fabric tape crossed in 2 layers laminated free edge cut 2.5cm width",
        "aliases": [
            "binding",
            "tape",
            "power mesh",
            "mesh",
            "shell fabric",
            "fabric",
            "laminated",
            "lamination",
            "width",
            "5cm",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Binding",
        "text": "Double bartack V fold bindingcover stitch",
        "aliases": [
            "binding",
            "binding tape",
            "bartack",
            "coverstitch",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Binding",
        "text": "Inner binding only attached to outer shell layer (Not visible at inner view)",
        "aliases": [
            "binding",
            "binding tape",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Binding",
        "text": "Inner binding tape",
        "aliases": [
            "binding",
            "binding tape",
            "tape",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Binding",
        "text": "Inner binding to attach 2 back panel and shell fabric tape",
        "aliases": [
            "binding",
            "back panel",
            "back",
            "binding tape",
            "tape",
            "shell fabric",
            "fabric",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Binding",
        "text": "Inner binding with stretch tape & 2NDLS",
        "aliases": [
            "binding",
            "binding tape",
            "tape",
            "2ndls",
            "lockstitch",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Binding",
        "text": "Ready - made soft stretch tape",
        "aliases": [
            "binding",
            "tape",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Binding",
        "text": "Rigid tape at inner apex point",
        "aliases": [
            "binding",
            "tape",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Binding",
        "text": "Rigid tape attached at inner apex of adjustable panel",
        "aliases": [
            "binding",
            "tape",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Binding",
        "text": "Underbust: inner binding w/ stretch tape & 2NDLS",
        "aliases": [
            "binding",
            "binding tape",
            "tape",
            "2ndls",
            "lockstitch",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Binding",
        "text": "V - fold binding - ZZ stitch 8mm (folded width)",
        "aliases": [
            "binding",
            "binding tape",
            "folded width",
            "width",
            "8mm",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Back panel heig",
        "aliases": [
            "back panel",
            "back",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Back panel height at Center",
        "aliases": [
            "back panel",
            "back",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Back panel height at the attachment*",
        "aliases": [
            "back panel",
            "back",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Back panel in 1 layer shell",
        "aliases": [
            "back panel",
            "back",
            "veralifting"
        ],
        "source": "Veralifting/VeraLifting vB 1.0 Sketch.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Back panel in single layer of shell fabric",
        "aliases": [
            "back panel",
            "back",
            "shell fabric",
            "fabric",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm v.A 1.0.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Single - layered shell fabric bottom back panel",
        "aliases": [
            "back panel",
            "back",
            "shell fabric",
            "fabric",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Single layer shell fabric at back panel",
        "aliases": [
            "back panel",
            "back",
            "shell fabric",
            "fabric",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf; KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Back Panel",
        "text": "Single layer shell fabric with dart at outer front + back panel",
        "aliases": [
            "back panel",
            "back",
            "shell fabric",
            "fabric",
            "front",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Single layered shell fabric at back panels",
        "aliases": [
            "back panel",
            "back",
            "shell fabric",
            "fabric",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Top back panels joined with bottom back panel - O/L, bagout",
        "aliases": [
            "back panel",
            "back",
            "overlock",
            "o/l",
            "ol",
            "bagout",
            "clean finish",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Back Panel",
        "text": "Upper back panel: 2 layers of Power mesh",
        "aliases": [
            "back panel",
            "back",
            "power mesh",
            "mesh",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Stitching",
        "text": "Center gore O/L + bagout 1NDL topstitch at inner mesh",
        "aliases": [
            "stitching",
            "overlock",
            "o/l",
            "ol",
            "1ndl",
            "topstitch",
            "bagout",
            "clean finish",
            "trulysofty"
        ],
        "source": "TrulySofty/TrulySofty-vB-1.0.pdf"
    },
    {
        "category": "Stitching",
        "text": "Cradle in 2 layers: Outer in 2 panels: side panel in shell fabric attach with CF microfiber mesh panel by O/L then top stitch on shell panel Liner: Full 1 panel of microfiber mesh",
        "aliases": [
            "stitching",
            "cf",
            "center front",
            "shell fabric",
            "fabric",
            "overlock",
            "o/l",
            "ol",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Stitching",
        "text": "Cradle in 2 layers: Outer: Full 1 panel of microfiber mesh Liner: in 2 panels: side panel in shell fabric attach with CF p.m panel by O/L then top stitch on shell panel",
        "aliases": [
            "stitching",
            "cf",
            "center front",
            "shell fabric",
            "fabric",
            "overlock",
            "o/l",
            "ol",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Stitching",
        "text": "Outer mesh attached together at CF by O/L. Topstitch on WL side",
        "aliases": [
            "stitching",
            "cf",
            "center front",
            "overlock",
            "o/l",
            "ol",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-1.0.pdf; KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Stitching",
        "text": "Single layer of shell fabric attach with p.m panel by O/L then zigzag stitch on shell panel",
        "aliases": [
            "stitching",
            "shell fabric",
            "fabric",
            "zigzag",
            "zz",
            "overlock",
            "o/l",
            "ol",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Stitching",
        "text": "sizes) by coverstitch",
        "aliases": [
            "stitching",
            "coverstitch",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Hardware",
        "text": "1 male snap button on adjustable panel Size: 9mm all sizes",
        "aliases": [
            "hardware",
            "snap",
            "snap button",
            "9mm",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Hardware",
        "text": "5 cm Distance from center between snaps: 1.5 cm",
        "aliases": [
            "hardware",
            "snap",
            "snap button",
            "5cm",
            "5 cm",
            "amorafit"
        ],
        "source": "AmoraFit/AmoraFit VA 1.0.pdf"
    },
    {
        "category": "Hardware",
        "text": "Nylon coated 8 - shaped ring",
        "aliases": [
            "hardware",
            "ring",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Fabric Layers",
        "text": "Double layered shell laminated at front side panel",
        "aliases": [
            "fabric layers",
            "laminated",
            "lamination",
            "front",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift vB 2.0.pdf"
    },
    {
        "category": "Fabric Layers",
        "text": "Power mesh ZZ",
        "aliases": [
            "fabric layers",
            "power mesh",
            "mesh",
            "veralifting"
        ],
        "source": "Veralifting/Veralifting vA 1.0 sketch 5.12.2026.pdf"
    },
    {
        "category": "Fabric Layers",
        "text": "Shell fabric (Synthetic)",
        "aliases": [
            "fabric layers",
            "shell fabric",
            "fabric",
            "kiraform"
        ],
        "source": "KiraForm/KiraForm-vB-2.0 (1).pdf"
    },
    {
        "category": "Fabric Layers",
        "text": "Shell fabric - Contrast",
        "aliases": [
            "fabric layers",
            "shell fabric",
            "fabric",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Fabric Layers",
        "text": "Shell fabric - Solid",
        "aliases": [
            "fabric layers",
            "shell fabric",
            "fabric",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Measurement",
        "text": "0cm(inner width)",
        "aliases": [
            "measurement",
            "width",
            "0cm",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Measurement",
        "text": "16 mm (full width)",
        "aliases": [
            "measurement",
            "width",
            "16mm",
            "16 mm",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Measurement",
        "text": "1cm(inner width)",
        "aliases": [
            "measurement",
            "width",
            "1cm",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Measurement",
        "text": "4 rows + 4 columns All size",
        "aliases": [
            "measurement",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Measurement",
        "text": "5cm(inner width)",
        "aliases": [
            "measurement",
            "width",
            "5cm",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Measurement",
        "text": "H & E at CB 5 rows, 4 columns for all sizes",
        "aliases": [
            "measurement",
            "cassielift"
        ],
        "source": "CassieLift/CassieLift v.A 2.0.pdf"
    },
    {
        "category": "Measurement",
        "text": "Width 2.5cm All sizes",
        "aliases": [
            "measurement",
            "width",
            "5cm",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Other",
        "text": "Bottom panel height at Center Front",
        "aliases": [
            "other",
            "center front",
            "cf",
            "front",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Other",
        "text": "Center Front Height",
        "aliases": [
            "other",
            "center front",
            "cf",
            "front",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf; SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Other",
        "text": "Cradle Height at Center Front*",
        "aliases": [
            "other",
            "center front",
            "cf",
            "front",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Other",
        "text": "Measurement Spec 3597_ Measurement Spec_21.Apr.2026_ Size set",
        "aliases": [
            "other",
            "measurement",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    },
    {
        "category": "Other",
        "text": "Measurement Spec SofieLift 3.0 - 15.May.26 Description - English POM Bottom band relax 1/2",
        "aliases": [
            "other",
            "measurement",
            "sofielift",
            "sofylift"
        ],
        "source": "SofyLift/Copy of SofieLift 3.0 (initially SofyLift v.B 4.0) - 12.5.2026.xlsx.pdf"
    },
    {
        "category": "Other",
        "text": "Please make the 1st proto sample in size S and L so that it meets the measurement chart S L",
        "aliases": [
            "other",
            "measurement",
            "mesh",
            "bounce"
        ],
        "source": "3597 Mesh Bounce-Control Bra/3597. (ATD) Full coverage Mesh Bounce-control Bra - Google Sheets.pdf"
    }
];
