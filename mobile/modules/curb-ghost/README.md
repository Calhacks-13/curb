# Native ghost vehicle

The local Expo module draws a real SceneKit car over the existing VisionCamera
preview. It does not open a second camera or start an ARKit session. The scene
is rendered on demand; CoreML and camera capture keep their existing lifecycle.

`ghostPlacement.ts` requires fresh aligned analysis, a confirmed interior gap and
two visible vehicle anchors in the same image row. The car occupies 96% of the
detected opening width, with height derived from its 3D proportions and its wheels
aligned to the neighboring ground line. Camera framing uses the model geometry,
without extra viewport padding. It preserves the model's proportions and excludes
narrow, off-screen and frame-edge gaps. This is an illustrative preview: depth,
road-plane orientation, occlusion, vehicle fit and legality are not measured.
The interface explicitly labels fit as unverified. A future measured placement
needs synchronized camera intrinsics/pose and road-plane or depth information.

The local module is discovered through `expo-module.config.json`. After changing
native code or adding this module, run `pod install` from `mobile/ios` and rebuild.

## Asset

`assets/parking-car.scn` is adapted from **Tesla 2018 Model 3** by Ameer Studio,
licensed under CC BY 4.0. Full source and license details are in
`assets/CREDITS.txt`, bundled with the app and linked in Scan details. Asset
licensing is separate from the module's code license.

Adaptations remove concealed interior detail, simplify large meshes, normalize
orientation and scale, replace textures with grayscale materials and add a soft
ground shadow. The renderer composites the finished scene at 42% opacity. Model
framing is cached per orientation so the larger asset is not remeasured on every
layout update.

The source GLB's embedded metadata records its title, author, license and original
Sketchfab URL. A redistributable copy is available at:
https://raw.githubusercontent.com/jamesalmeida/tesla-infotainment/main/public/car-models/tesla-model-3-2018.glb

Expected source SHA-256:
`d6d78c9bd1bd9c7ca87a07509a2e7b6585995fcbdec054f297167ba7c15cd878`

Regenerate on macOS in a separate Python environment with `numpy`, `trimesh` and
`fast-simplification` installed (these are asset tooling, not app dependencies):

```sh
python prepare-model.py /path/to/tesla-model-3-2018.glb /tmp/car-meshes.json
swift prepare-model.swift /tmp/car-meshes.json assets/parking-car.scn
```
