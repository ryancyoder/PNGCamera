# Perspective Elevation Ruler

An iPad-friendly web app that draws an elevation ruler **into** a perspective
photograph. You mark two points whose elevations and separation you already
know; it works out where the camera must have been standing and projects
elevation increments back onto the picture through a real 3D camera model.

The result reads like looking through a virtual surveying instrument at the
photograph, rather than like lines pasted on top of it.

```
                    HOUSE

              ───────────────  +104'

           ───────────────────  +103'

        ──────────────────────  +102'

   ────────────────────────────  +101'

───────────────────────────────  +100'
              ORIGIN
```

## The one thing to understand

**This is a line-of-sight instrument, not a contour map.** Every elevation the
app shows is valid along one vertical measurement plane — the plane containing
the camera and the sight line you set. A ruler increment says nothing about the
ground to its left or right. The app says so on screen, on every exported
image, and it snaps measurement points onto that sight line rather than letting
you take a reading where the geometry does not apply.

It is a visual estimating and annotation tool. It is not survey grade, and it
labels every reading either `MEASURED` (an elevation you typed in) or
`PROJECTED` (interpolated from the calibration).

## Running it

No build step and no dependencies. Either:

```sh
cd PerspectiveElevationRuler
python3 -m http.server 8080     # then open http://localhost:8080
```

or use the single-file build, which is the easy way onto an iPad — AirDrop it,
e-mail it, or drop it in Files and open it straight from Safari:

```sh
node tools/build.mjs            # writes dist/perspective-elevation-ruler.html
```

That one file works from `file://` with no server at all.

```sh
node tests/run.mjs              # unit tests for the projection maths
```

To put it on the web permanently, GitHub Pages serves this directory as-is —
there is nothing to compile. Point Pages at the branch and the app lives at
`.../PerspectiveElevationRuler/`.

### Saving the exported image

Export composites a fresh PNG and offers it three ways, because no single route
works everywhere. The share sheet is used when the browser has one — that is
the direct path to *Save Image* on iPadOS. Otherwise the image is shown full
size and a press-and-hold saves it, which works even where a page is not
allowed to start a download. Where the page is embedded in a host that mediates
saving, the Save button goes through the host instead of offering a link that
would quietly do nothing.

## Site survey — map for distance, tilt for angle

A field survey that measures what the photo calibration would otherwise ask you
to guess. It follows the model proven in the **Upright** field app: height above
the device is `d·tan(θ)`, and the distance comes from where pins sit on a plan,
never from GPS — a tapped pin against an aerial beats a 3–5 m fix, and that is
what makes the numbers worth anything.

Five standard points, shot from one position:

| | point | what it does |
| --- | --- | --- |
| 1 | Observation point | Where you stand, across the street. The datum. |
| 2 | Curb at the house | **Assumed level with where you stand.** |
| 3 | Foundation | Where the wall meets the ground. |
| 4 | Roof eave | Top of the wall. |
| 5 | Roof peak | The ridge. |

Point 2 is the one that does the real work. Upright cancels the device's own
height by differencing two sightings from one position, which gives elevations
relative to an anchor but never the height itself. Declaring the curb level with
the ground you are standing on solves for it outright:

```
elevation of curb above the device = d_curb · tan(θ_curb)
elevation of curb above your feet  = 0            (the assumption)
=>  h = −d_curb · tan(θ_curb)
```

and every other point then reads absolutely against the ground you stand on,
`E = h + d·tan(θ)`. That matters because it yields exactly what the building
calibration wants — camera height, wall height, distance to the wall and the
grade below the foundation — measured rather than typed. **Use for photo
calibration** hands them over, and the surveyed distance places the horizon, so
the photo needs only its two wall marks.

The survey measures the camera height from the ground and the photo derives it
from the geometry. Those are independent, so the panel reports the gap between
them as a **Survey check** — a real test of whether the photo was taken from the
observation point.

### Three pins, not five

The foundation, the eave and the peak are stacked on one wall, so they share one
pin; three pins on the same spot would be three ways to get one distance wrong.
The eave can never have its own — it is above its wall by definition. The ridge
can break away, because seen from the gutter side it stands back from the wall,
and leaving it on the wall pin reads it too low.

### The assumptions, stated

- **The curb is level with where you stand.** Where the street falls past the
  house it is not, and the instrument height can be a measured eye height instead.
- **The photo was taken from the observation point.** The Survey check is what
  catches it when it was not.
- Angles come from `acos(cos β · cos γ)` — the tilt off vertical, which does not
  care how the iPad is rolled in your hands. A shot averages the readings over a
  short dwell and reports their spread, which says how steadily you held it.
  Repeatability is not accuracy: five shots at a mis-placed pin will agree
  beautifully and all be wrong.

### Sighting through the camera

Tapping **Shoot** on a target opens a live camera preview with a crosshair. The
camera measures nothing — the angle still comes off the tilt sensor — but a
reading with no picture behind it gives you no way to know you were on the eave
rather than the gutter, and no way to tell afterwards which of five identical
readings was which.

Shots fire on **dwell**, as they do in Upright: hold the crosshair steady and it
takes the shot itself, rather than making you fumble for a button while aiming a
tablet at a roof. A ring fills while the hold counts down, so the automatic shot
is something you can see coming. After a shot it disarms until you move off the
target, or one long hold would machine-gun the same point. **Done** releases the
camera outright — iOS lights its recording indicator for any open track, whether
or not anything is reading from it.

The reading is taken at the instant the button goes down, not after the camera
opens: a permission prompt can sit there for seconds, and a reading captured
afterwards records wherever the iPad drifted to in the meantime.

### Where the camera and the tilt work

The camera and the motion sensors need the same two things, and both are silent
when missing: an **https** page, and one that is **not embedded in someone
else's**. A browser delegates camera and motion to an iframe only when the
embedder asks for it, and most do not — so in an embedded page the permission
prompt never appears and nothing ever arrives.

The app checks for both up front and says which is missing, rather than leaving
buttons that do nothing. Typed angles work everywhere, so an embedded copy is
still fully usable for the maths — it just cannot aim or read the iPad.

To sight through the camera, open the app at its own https address: GitHub Pages
off this repo, or any static host. Opening the single-file build from Files will
not do it either — `file://` is not a secure context.

### Why a plan and not a live map

Map tiles are images from a third-party host, and some hosts block those
outright — a published Artifact will not load one. An imported aerial screenshot
works everywhere, can be framed on the property before capture, and is what is
to hand anyway. A blank grid with a typed scale measures just as well; the scale
is what makes a distance real, not the picture.

## Two ways to calibrate

**From a building** (the default). Nothing you have to supply is a horizontal
distance — the one number that is genuinely hard to know standing in a yard:

1. **Foundation** — tap where the wall meets the ground. This is the zero line.
2. **Wall height** — tap a point straight above it whose height you know (a
   course of siding, a door head, the top of the wall) and type that height.
3. **Horizon** — drag it onto the horizon you can see.

Those three plus the wall height close the system exactly. Above the foundation
the ruler runs straight up the wall; below it, out across the grade.

**From two ground points** — the original method, for open landscape with no
building to measure against. That is the workflow below.

## Workflow

1. **Photograph.** Take one with the iPad camera or pick one from the library.
2. **Origin.** Tap the point whose elevation you know, and type that elevation.
3. **Point B.** Tap a second known point on the same sight line, and enter its
   elevation, the horizontal distance between the two, and whether it is nearer
   to you or farther away than the origin. Photographing a house from its yard
   puts the foundation at the far end, so Point B is often the nearer one.
4. **Scale.** Set what one line means for each half of the ruler — a siding
   course above, a step riser below — or leave both at whole feet.
5. **Line of sight.** It runs through both reference points and is drawn
   through the picture to its vanishing point. Drag either point to re-aim it.
6. **Calibrate.** Set the perspective strength, then fine-tune. If you can see
   where the horizon falls in the photograph, **drag it** — that is usually the
   quickest and most reliable route. Otherwise fine-tune by camera height or
   line-of-sight distance. Both reference points stay pinned to the pixels you
   tapped whatever you change.
7. **Measure.** Tap `Add Point` and tap along the sight line. Drag a point and
   its elevation updates continuously.
8. **Annotate and export.** Select two points for a vertical dimension,
   horizontal distance, or slope/grade label, then export a PNG.

The original photograph is never modified — the export composites into a new
canvas every time.

## How the projection works

World coordinates, with the camera at `(0, cameraHeight, 0)` looking along `+Z`
tilted down by `pitch`:

```
X = horizontal, across the line of sight
Y = elevation, relative to the origin's elevation
Z = horizontal distance from the camera, along the line of sight
```

A real camera looking down a sight line necessarily sits *in* the vertical
plane containing it, so the measurement plane is exactly `X = 0`. A plane
through the camera centre projects to a straight **line** in the image — which
is why the measurement plane appears as the single line of sight you place, and
why the app can work on a tilted or rolled photograph without asking you about
roll.

### The calibration

Both reference points lie on that line, so each contributes one number: its
angle `α` above the optical axis. With the camera pitched down by `θ`, the ray
to a point has depression `β = θ − α`, and

```
tan(β_A) = h / Z_A                  the origin, at elevation 0
tan(β_B) = (h − ΔY) / (Z_A + D)     the known point
```

Two equations, three unknowns (`θ`, `h`, `Z_A`) — genuinely one short, which is
why there is a fine-tune control rather than a pretence of a full solve. Fixing
any one of the three closes the system, and fixing `θ` makes it linear:

```
h = (−ΔY·cot β_B − D) / (cot β_A − cot β_B)
```

So `solveFromPitch` is closed form, and the "camera height" and "line-of-sight
distance" modes root-find on pitch over that same closed form. Every mode keeps
both reference points on the exact pixels you tapped.

### Calibrating from a building

Both wall marks sit at the same distance and differ only in elevation, so with
the horizon fixing the pitch the system closes with no searching at all:

```
tan(beta_foundation) = h / Z
tan(beta_wall)       = (h - W) / Z

=>  Z = W / (tan beta_foundation - tan beta_wall)
    h = Z * tan beta_foundation
```

Scale comes from the wall height and shape from the field of view: double the
wall height and both the distance and the camera height double with it.

The sight line runs *up* the wall, which is consistent with the sight line
running *away* from the camera — raising a point's elevation always raises its
along-sight coordinate, since `dt/dY = f*Z/zc^2 > 0` for any pitch.

What this does not give you is the grade below the foundation. Both marks are on
the wall, so nothing here observes the ground. Nor can that grade be dragged
into place: the ground below the foundation lies in the measurement plane, and
that plane projects to the sight line, so every grade draws the same line in the
image and only slides where along it each level falls. So the grade is a value
you set, and the honest thing is to say so rather than derive it from nothing.

### Why the horizon is the control worth reaching for

The horizon sits at `t = focalPx * tan(theta)` along the sight line, which makes
its position a direct read of the camera's pitch. Placing it therefore fixes
`theta`, and camera height and origin distance follow from the closed form above
with nothing to search for.

It is also the only one of the three you can actually *see*. Camera height and
distance are recollections; the horizon is in the photograph. And because every
point in the scene at the camera's own elevation projects onto it, the horizon
is the camera's eye level — so the app labels it with the elevation it implies,
which is the number that tells you whether the placement is sane.

Dragging is confined to the frame. Off the frame the horizon cannot be seen or
grabbed, so flinging it away would lose the handle for good along with any sane
camera; the slider still covers the full range for a photograph whose horizon
genuinely falls outside the picture.

### The ruler

Three styles, all projected rather than drawn:

- **Follow the grade** — each elevation increment is a rung placed where the
  calibrated grade reaches that elevation, so climbing the ruler walks you into
  the distance. Rungs shorten and bunch together as they recede, and are faded
  by depth.
- **Foundation** — for measuring against a building. Mark the foundation as the
  zero line: above it the increments run straight up at the foundation's own
  distance, because that is what "8 ft above the foundation" means — you do not
  walk backwards to measure a wall. Below it they project out across the grade,
  which is what "2 ft below the foundation" means out in the yard. The two
  halves meet exactly at the datum, since the zero rung is the same point in
  both, and a tapped measurement switches rule at the same line so a reading
  always agrees with the ruler drawn through it.
- **Levelling staff** — a virtual rod at one distance, graduated in elevation.
  Nothing recedes, but the graduations still converge on the vertical vanishing
  point, so they open out or close up depending on which way the camera tilts.

### Scales

The two halves of a foundation ruler measure different things, so each has its
own scale. Above the datum you are counting up a wall; below it you are counting
out across the ground. A single increment can only ever suit one of them.

Either half can be set to a real building dimension — a 5½ in siding course, an
8 in block course, a 7½ in step riser — or to anything you type in inches. Give a
scale something to count and the ruler will label it that way:

```
                    ────────────  20 courses
                    ────────────  15 courses
  FOUNDATION  ══════════════════   0.00'
         ──────────────────────    2 steps
    ────────────────────────────   4 steps
```

which answers the question people actually ask standing in a yard — *how many
steps to get up to the house* — rather than making them divide a decimal
elevation by a riser height in their head. Tapped points carry the same count,
so a spot 3 ft below the foundation reads `4.8 steps` as well as `-3.00'`.

A grade staircase is entirely projected and a levelling staff is entirely
vertical, so those two styles take the scale that matches what they measure.

Equal real-world increments are never equally spaced in pixels. The test suite
asserts exactly that.

## Architecture

The mathematics has no idea the user interface exists. Everything in
`src/core/` is pure functions and plain data, runs under Node, and is unit
tested without a browser.

```
src/core/
  Geometry.js               2D vector helpers, clipping, root finding
  SiteSurvey.js             the five-point grade survey; pins and angles -> elevations
  PerspectiveProjection.js  the pinhole camera; world <-> photo pixels
  PerspectiveCalibration.js solves a camera from the two known points
  ElevationModel.js         elevations, increments, grade, formatting
  ElevationRuler.js         builds and projects the ruler geometry
  MeasurementAnnotation.js  one measured point; one dimension between two
  AnnotationManager.js      owns points and dimensions, hit testing
src/ui/
  PhotoView.js              canvas, view transform, pinch/pan/drag gestures
  SitePlanView.js           the plan: aerial backdrop, scale bar, draggable pins
  SightView.js              camera preview and crosshair; shots fire on dwell
  TiltSensor.js             device orientation -> shot angle, with a dwell average
  OverlayRenderer.js        draws the scene in photo pixel coordinates
  ExportManager.js          composites the export, share sheet / download
  App.js                    state, wiring, the step-by-step flow
tools/build.mjs             concatenates it all into one HTML file
tests/run.mjs               unit tests
```

`OverlayRenderer` draws in photo pixel coordinates with the transform supplied
by the caller. The screen uses a fit-to-viewport transform and the export uses
the identity at full resolution, so the exported image is the same picture you
were looking at.

## Notes for iPad

- `Take Photo` uses a capture-enabled file input, so it opens the camera
  directly with no permission dance.
- One finger drags a point or pans; two fingers pinch to zoom. Measurement
  points snap to the sight line.
- Export goes through the share sheet where available (that is the only route
  to *Save Image* on iPadOS) and falls back to a download.
- The session — photograph included, if it is small enough — is kept in local
  storage, so a reload does not lose your work.

## Deliberately not in this version

No GPS, LiDAR, ARKit, terrain recognition, AI image analysis, terrain meshes,
contour mapping, cut/fill, or automatic elevation extraction. The point of this
prototype is to get the perspective projection and the elevation ruler right
first.

## Known limitations

- The camera is assumed to sit in the measurement plane and the principal point
  is taken as the point of the sight line closest to the image centre. A
  heavily cropped or off-centre photograph makes that an approximation.
- Lens distortion is not modelled. A very wide-angle or fisheye shot will not
  line up perfectly across the whole frame.
- The ground between the two reference points is assumed to be a straight
  grade. Where the real ground is convex or concave, readings between the two
  known points are interpolated along that straight line.
- Foundation mode assumes the wall is a flat face square to the sight line and
  standing at the origin's distance. A reading taken up a wall that leans, or
  is angled away from the sight line, will drift.
- Accuracy degrades sharply near the horizon, where a pixel is worth a large
  distance. Readings far past the second reference point are extrapolation.
- The wall mark must sit directly above the foundation mark on a flat face
  square to the sight line. A wall that leans, or is seen obliquely, will drift.
- A shallow grade drops very little across a yard — 2% over 70 ft is 1.4 ft — so
  whole-foot lines below the foundation land far out or off the frame entirely.
  Drop the increment to 0.25 ft and they come back.
- Placing the horizon by eye is only as good as the horizon is visible. A
  treeline or ridge is *above* the true horizon, not on it; over water or a
  level field the line is trustworthy, on rolling ground it is a starting point
  to refine.
