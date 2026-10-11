# Office prop kit — provenance

The six models in this directory are vendored, unmodified, from a third-party
asset pack. This file is the licence record: it is what makes it safe to ship
the bundle these files end up in.

| | |
| --- | --- |
| Pack | **Furniture Kit** |
| Version | **2.0** (pack's own `License.txt` records a creation date of 20-10-2018) |
| Author | Kenney — <https://kenney.nl> |
| Licence | **CC0 1.0 Universal** (public domain dedication) — <https://creativecommons.org/publicdomain/zero/1.0/> |
| Pack page | <https://kenney.nl/assets/furniture-kit> |
| Archive | <https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip> |
| Retrieved | 2026-10-03 |

`LICENSE.txt` beside this file is the pack's own licence text, copied verbatim
out of the archive. CC0 asks for nothing, but the pack asks to be credited, so
the repository README credits Kenney and so does this file.

## What was taken

Only the `Models/GLTF format/` entries the office needs — 85 KB in total, which
is small enough to vendor rather than fetch at runtime. Each file is byte-for-byte
the archive's copy; nothing was re-exported, re-scaled, or re-materialled.

| Prop kind | File | From the archive |
| --- | --- | --- |
| `desk` | `desk.glb` | `Models/GLTF format/desk.glb` |
| `chair` | `chairDesk.glb` | `Models/GLTF format/chairDesk.glb` |
| `monitor` | `computerScreen.glb` | `Models/GLTF format/computerScreen.glb` |
| `plant` | `pottedPlant.glb` | `Models/GLTF format/pottedPlant.glb` |
| `door` | `doorwayOpen.glb` | `Models/GLTF format/doorwayOpen.glb` |
| `coffee` | `kitchenCoffeeMachine.glb` | `Models/GLTF format/kitchenCoffeeMachine.glb` |

The prop kinds on the left are the shared layout's `AssetPropKind` union, and
`apps/client/src/scene/propKit.ts` is the registry that holds this mapping in
code. Adding a kind means adding a row here too.

### Checksums

`sha256`, so a re-download can be checked against what is committed:

```
0164fe828f028b321730fb8c74502e353583f751be74da1682d42fff7d3c5a42  desk.glb
46406619186034cbe92b19b79a5f1a8e3f442a17a70a7524ef2c0ad0f35095c6  chairDesk.glb
5942cbad29a2d2b956619569926e81d50a4174403d592fece6556e57632dc643  computerScreen.glb
5b760eda2766f75fda36b2c5df652a1662f82981ef64cd8fa7fe7bcd386b3a15  pottedPlant.glb
cf05e165ea26dbbeaab4dc6296c143ef5f5a001e2ab5af9cd4fd65739408317e  doorwayOpen.glb
063f582c6fa0f00a9f24e3393dac2295491c4becdaf5513c893ab1a2826b6ec3  kitchenCoffeeMachine.glb
```

## Re-fetching

```sh
curl -LO "https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip"
unzip -j kenney_furniture-kit.zip 'Models/GLTF format/desk.glb' -d .
```

## Notes for anyone adding a model

- The pack is untextured: every model is a handful of flat-coloured materials and
  a few hundred vertices. There are no images to load, which is why the kit costs
  85 KB and why the loader never needs a texture path.
- The pack is authored at roughly half-metre scale and its models are *not*
  centred on the origin. The loader normalises both — see `KIT_SCALE` and
  `normalise` in `apps/client/src/scene/propKit.ts` — so no measurement from this
  pack is written down anywhere in the source.
