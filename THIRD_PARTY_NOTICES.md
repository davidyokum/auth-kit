# Third-party notices

auth-kit has no runtime dependencies beyond those in `package.json`. It includes the following
third-party material in its source and build.

## Licences in this package

auth-kit's code is under the MIT License (`LICENSE`). Not everything in the package is auth-kit's code:

- **OpenStreetMap map data, under the ODbL 1.0, not MIT.** The lakes, rivers, and creeks in
  `src/backdrops/styles/county-survey/data.ts` and `src/backdrops/styles/river-basins/data.ts`, and in
  the `dist/` chunks built from them (the County Survey and River Basins styles' code, each of which
  carries this notice in a comment), are © OpenStreetMap contributors and are made available under the
  Open Database License 1.0. The MIT License doesn't cover that data. See [OpenStreetMap](#openstreetmap)
  below.
- The other material below keeps its own licence (ISC, BSD 3-Clause), or is in the public domain.

## Lucide icons

`src/client/icons.tsx` draws icons from [Lucide](https://lucide.dev), as published in lucide-react
0.475.0: fingerprint, mail, chevron-right, arrow-left, info, and check as drawn there; circle-alert,
circle-help, copy, and refresh-cw adapted (simplified paths). Under the ISC License:

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All
other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee
is hereby granted, provided that the above copyright notice and this permission notice appear in all
copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE
FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The password-field glyph in the same file is auth-kit's own.

## The plotter backdrops' data

The `county-survey`, `river-basins`, and `star-chart` backdrops (`src/backdrops/styles/*/data.ts`)
draw from the following data, pre-projected, simplified, and compactly encoded. Each `data.ts` header
names its sources in detail.

### d3-celestial

`src/backdrops/styles/star-chart/data.ts` holds the constellation figures and names from
[d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn (each figure vertex matched to its
catalogue star). Under the BSD 3-Clause License:

```
Copyright (c) 2015, Olaf Frohn
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions
   and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions
   and the following disclaimer in the documentation and/or other materials provided with the
   distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse
   or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### The Yale Bright Star Catalogue

The stars in `src/backdrops/styles/star-chart/data.ts` (positions for equinox J2000 and visual
magnitudes, all stars to magnitude 5.5 plus every star in the figures) are from the Yale Bright Star
Catalogue, 5th revised edition (Hoffleit and Warren, 1991), as distributed by the NASA Astronomical Data
Center and the CDS (catalogue V/50).

### OpenStreetMap

The lakes, rivers, and creeks in `src/backdrops/styles/county-survey/data.ts` and
`src/backdrops/styles/river-basins/data.ts` (and the `dist/` chunks built from them) are © OpenStreetMap
contributors: https://www.openstreetmap.org/copyright. They're extracted from OpenStreetMap,
pre-projected, simplified, and re-encoded, so together they're a database derived from it, and that
database is made available under the Open Database License 1.0 (ODbL),
https://opendatacommons.org/licenses/odbl/1-0/, separately from auth-kit's MIT-licensed code. Anyone who
publicly uses an adapted version of this data offers it under the ODbL too (ODbL §4.4).

The pictures the County Survey and River Basins backdrops draw from it are produced works, which need
attribution: each sheet carries "WATER FEATURES © OPENSTREETMAP CONTRIBUTORS" in its notes.

### U.S. Census Bureau and USGS (public domain)

County and state boundaries (Census cartographic boundary files and TIGER/Line 2024), interstates and
US highways (TIGER/Line 2024 primary and secondary roads), and county seat locations (Census 2024
Gazetteer) are from the U.S. Census Bureau. The river basins (Watershed Boundary Dataset HUC-8 units, as
listed in G.S. 143-215.8B), elevation (3DEP), and place and sound names (GNIS) are from the U.S.
Geological Survey. Works of the U.S. federal government are in the public domain.
