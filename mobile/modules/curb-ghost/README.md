# Native ghost vehicle

The local Expo module draws a real SceneKit car over the existing VisionCamera
preview. It does not open a second camera or start an ARKit session. The scene
is rendered on demand; CoreML and camera capture keep their existing lifecycle.

`ghostPlacement.ts` requires fresh aligned analysis, a confirmed interior gap and
two visible vehicle anchors in the same image row. It uses neighbor dimensions
for approximate image scale, preserves the model's proportions and excludes
narrow, off-screen and frame-edge gaps. This is an illustrative preview: depth,
road-plane orientation, occlusion, vehicle fit and legality are not measured.
The interface explicitly labels fit as unverified. A future measured placement
needs synchronized camera intrinsics/pose and road-plane or depth information.

The local module is discovered through `expo-module.config.json`. After changing
native code or adding this module, run `pod install` from `mobile/ios` and rebuild.

## Asset

`assets/parking-car.scn` is adapted from Khronos CarConcept. The full credit and
license links are in `assets/CREDITS.txt`, bundled with the app and linked from
Scan details. Original textures/logos and hidden interior geometry were removed.
The car uses custom translucent body, glass, tire, rim and lighting materials.

To regenerate on macOS, download the CarConcept GLB from the source listed in
CREDITS.txt. In a separate Python environment with trimesh and numpy installed:

```sh
python prepare-model.py /path/to/CarConcept.glb /tmp/car-meshes.json
swift prepare-model.swift /tmp/car-meshes.json assets/parking-car.scn
```
