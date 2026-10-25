"""Convert CarConcept.glb to geometry JSON for prepare-model.swift (trimesh 4.12).
Original asset and attribution: assets/CREDITS.txt. No original logos/textures retained.
Usage: python prepare-model.py /path/to/CarConcept.glb /tmp/car-meshes.json
"""
import json
import sys
import numpy as np
import trimesh
scene = trimesh.load(sys.argv[1])
meshes = []
for node in scene.graph.nodes_geometry:
    transform, key = scene.graph[node]
    if key.startswith('Interior') or 'Wiper' in key or 'HoodInterior' in key or key == 'Engine':
        continue
    mesh = scene.geometry[key].copy()
    mesh.apply_transform(transform)
    vertices = np.asarray(mesh.vertices)
    faces = np.asarray(mesh.faces)
    normals = np.zeros_like(vertices)
    face_normals = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]], vertices[faces[:, 2]] - vertices[faces[:, 0]])
    for axis in range(3):
        np.add.at(normals, faces[:, axis], face_normals)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-10)
    meshes.append(dict(name=key, material=mesh.visual.material.name or '', vertices=vertices.round(6).tolist(), normals=normals.round(6).tolist(), faces=faces.reshape(-1).tolist()))
with open(sys.argv[2], 'w') as output:
    json.dump(meshes, output, separators=(',', ':'))
