export interface Example {
  name: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    name: 'Parametric box (customizer)',
    code: `// Parametric storage box – try the Customizer panel on the right!

/* [Box] */
// Outer width (X)
width = 60; // [20:200]
// Outer depth (Y)
depth = 40; // [20:200]
// Outer height (Z)
height = 30; // [10:100]
// Wall thickness
wall = 2; // [1:0.5:6]
// Corner radius
radius = 5; // [0:0.5:15]

/* [Compartments] */
// Number of compartments along X
columns = 3; // [1:6]
// Number of compartments along Y
rows = 2; // [1:4]

/* [Label] */
show_label = true;
label = "PARTS";
label_size = 6; // [3:12]

/* [Appearance] */
box_color = "SteelBlue"; // [SteelBlue, Tomato, Gold, SeaGreen, Orchid]
// Show the lid as a translucent ghost
show_lid = true;

/* [Hidden] */
$fn = 48;

module rounded_box(size, r) {
  if (r <= 0) cube(size);
  else hull() for (x = [r, size.x - r], y = [r, size.y - r])
    translate([x, y, 0]) cylinder(r = r, h = size.z);
}

color(box_color) difference() {
  rounded_box([width, depth, height], radius);
  // compartments
  cw = (width - wall) / columns;
  cd = (depth - wall) / rows;
  for (i = [0:columns-1], j = [0:rows-1])
    translate([wall + i * cw, wall + j * cd, wall])
      rounded_box([cw - wall, cd - wall, height], max(0, radius - wall) / 2);
  // engraved label on the front
  if (show_label)
    translate([width / 2, 0.6, height / 2]) rotate([90, 0, 0])
      linear_extrude(1) text(label, size = label_size, halign = "center", valign = "center");
}

if (show_lid)
  %translate([0, 0, height + 10]) rounded_box([width, depth, wall], radius);
`,
  },
  {
    name: 'Transparency & modifiers',
    code: `// Correct order-independent transparency (depth peeling)
// and the # (highlight) and % (background) modifiers.

$fn = 64;

// translucent intersecting objects
color("red", 0.5) sphere(12);
color("lime", 0.4) translate([10, 0, 0]) sphere(10);
color([0.2, 0.4, 1, 0.5]) translate([5, 8, -2]) cube([10, 10, 20], center = true);

// a difference with a highlighted (#) cutter
translate([40, 0, 0]) difference() {
  color("gold") cube(20, center = true);
  #rotate([0, 90, 0]) cylinder(r = 6, h = 30, center = true);
  rotate([90, 0, 0]) cylinder(r = 4, h = 30, center = true);
}

// background (%) objects are not part of the model
%translate([-35, 0, 0]) cylinder(r = 10, h = 20, center = true);
translate([-35, 0, 0]) sphere(5);
`,
  },
  {
    name: 'Helical gear',
    code: `// Helical gear using polygon(), list comprehensions and twisted linear_extrude.

/* [Gear] */
teeth = 24; // [8:80]
module_size = 2; // [0.5:0.25:5]
thickness = 10; // [2:40]
twist = 20; // [-90:90]
bore = 6; // [0:20]

function involute(base_r, a) = base_r * [cos(a) + a * PI / 180 * sin(a), sin(a) - a * PI / 180 * cos(a)];

function rot2(p, a) = [p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a)];

function tooth_profile(n, m) =
  let(
    pitch_r = n * m / 2,
    base_r = pitch_r * cos(20),
    outer_r = pitch_r + m,
    root_r = pitch_r - 1.25 * m,
    max_a = sqrt(pow(outer_r / base_r, 2) - 1) * 180 / PI,
    half = 90 / n + (sqrt(pow(pitch_r / base_r, 2) - 1) - acos(base_r / pitch_r) * PI / 180) * 180 / PI,
    steps = 8,
    flank = [for (i = [0:steps]) involute(base_r, max_a * i / steps)]
  )
  concat(
    [rot2([root_r, 0], -half)],
    [for (p = flank) rot2(p, -half)],
    [for (i = [steps:-1:0]) rot2([flank[i].x, -flank[i].y], half)],
    [rot2([root_r, 0], half)]
  );

module gear2d(n, m) {
  pitch_r = n * m / 2;
  union() {
    circle(r = pitch_r - 1.25 * m, $fn = n * 4);
    for (i = [0:n-1]) rotate(i * 360 / n) polygon(tooth_profile(n, m));
  }
}

color("silver") difference() {
  linear_extrude(height = thickness, twist = twist, slices = 12)
    gear2d(teeth, module_size);
  if (bore > 0) translate([0, 0, -1]) cylinder(d = bore, h = thickness + 2, $fn = 32);
}
`,
  },
  {
    name: 'Vase (rotate_extrude)',
    code: `// A vase made with rotate_extrude of a computed profile.

height = 80; // [30:200]
wall = 1.6; // [0.8:0.2:4]
waist = 0.6; // [0.3:0.05:1]
$fn = 96;

function r(z) = 20 + 10 * sin(z / height * 300) * waist + z * 0.1;

profile = concat(
  [[0, 0]],
  [for (z = [0:2:height]) [r(z), z]],
  [for (z = [height:-2:wall]) [r(z) - wall, z]],
  [[0, wall]]
);

color("teal") rotate_extrude() polygon(profile);
`,
  },
  {
    name: 'CSG basics',
    code: `// The classic OpenSCAD logo-style CSG demo.
$fn = 64;

difference() {
  intersection() {
    cube(15, center = true);
    sphere(10);
  }
  for (r = [[0, 0, 0], [90, 0, 0], [0, 90, 0]])
    rotate(r) cylinder(r = 5, h = 20, center = true);
}

translate([25, 0, 0]) minkowski() {
  cube([10, 10, 4], center = true);
  sphere(2, $fn = 16);
}

translate([-25, 0, 0]) linear_extrude(height = 10, scale = 0.4, twist = 45)
  offset(r = 1) square(12, center = true);
`,
  },
  {
    name: 'Recursive tree',
    code: `// Recursive modules and random numbers.
depth = 6; // [1:8]
seed = 42; // [0:100]
spread = 30; // [5:60]
$fn = 12;

module branch(len, r, d) {
  color([0.45 - d * 0.03, 0.3 + (depth - d) * 0.08, 0.1]) cylinder(h = len, r1 = r, r2 = r * 0.7);
  if (d > 0)
    translate([0, 0, len])
      for (i = [0:2]) {
        rnd = rands(-10, 10, 2, seed + d * 10 + i);
        rotate([spread + rnd[0], 0, i * 120 + rnd[1] + d * 37])
          branch(len * 0.75, r * 0.7, d - 1);
      }
}

branch(30, 3, depth);
`,
  },
  {
    name: '2D shapes',
    code: `// 2D geometry is shown flat on the XY plane.
$fn = 48;
difference() {
  offset(r = 3) offset(delta = -3) square([60, 40]);
  for (x = [12:12:48]) translate([x, 20]) circle(4);
}
translate([0, -30]) text("OpenSCAD", size = 10);
translate([70, 20]) polygon([for (i = [0:9]) (i % 2 ? 8 : 20) * [cos(i * 36), sin(i * 36)]]);
`,
  },
];
