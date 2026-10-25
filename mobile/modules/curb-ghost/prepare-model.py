"""Prepare Ameer Studio's CC BY 4.0 Tesla 2018 Model 3 for the native preview.

Usage: python prepare-model.py /path/to/tesla-model-3-2018.glb /tmp/car-meshes.json
Tool dependencies (not app dependencies): numpy, trimesh, fast-simplification.
Attribution, source and license are in assets/CREDITS.txt.
"""
import hashlib
import json
import sys
import numpy as np
import trimesh

SOURCE_SHA256 = 'd6d78c9bd1bd9c7ca87a07509a2e7b6585995fcbdec054f297167ba7c15cd878'
with open(sys.argv[1], 'rb') as source:
    if hashlib.sha256(source.read()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Unexpected source asset; verify its metadata and license before adapting it.')
scene = trimesh.load(sys.argv[1])
meshes = []
rotate = np.diag([-1.0, 1.0, -1.0, 1.0])  # Model front faces +Z in Curb.
for node in scene.graph.nodes_geometry:
    transform, key = scene.graph[node]
    geometry = scene.geometry[key]
    material = (geometry.visual.material.name or '').lower()
    name = key.lower()
    # Remove concealed interior detail while preserving the authored exterior.
    if any(term in name for term in ('leather', 'carpet', 'belt', 'seat', 'suspensi', 'lcds', 'texture_buttons', 'interiorlight')):
        continue
    if name.startswith(('movsteer_', 'base_', 'frunkplastic_')):
        continue
    if name.startswith('door_') and not (material.startswith(('primary', 'glass', 'door_lf')) or 'mirror_inside' in material):
        continue
    if 'primary' in material:
        role = 'body'
    elif 'glass' in material:
        role = 'glass'
    elif material == 'wheels.6':
        role = 'tire'
    elif material.startswith('wheels') or name.startswith('hub_'):
        role = 'rim'
    elif 'tembus' in material:
        role = 'lens'
    elif 'light' in name and 'black' not in material:
        role = 'light'
    elif any(word in material for word in ('chrome', 'aluminium', 'mirror')) or name.startswith('chrome'):
        role = 'rim'
    else:
        role = 'trim'
    mesh = geometry.copy()
    mesh.apply_transform(rotate @ transform)
    if len(mesh.faces) > 4000:
        mesh.merge_vertices(merge_tex=True, merge_norm=True)
        mesh = mesh.simplify_quadric_decimation(face_count=max(2500, int(len(mesh.faces)*.32)))
    vertices = np.asarray(mesh.vertices)
    faces = np.asarray(mesh.faces)
    normals = np.zeros_like(vertices)
    face_normals = np.cross(vertices[faces[:,1]]-vertices[faces[:,0]], vertices[faces[:,2]]-vertices[faces[:,0]])
    for axis in range(3):
        np.add.at(normals, faces[:,axis], face_normals)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-10)
    meshes.append(dict(name=key, material=role, vertices=vertices.tolist(), normals=normals.round(6).tolist(), faces=faces.reshape(-1).tolist()))
# Preserve physical proportions, center the asset and place its tires on y=0.
all_vertices = np.concatenate([np.asarray(part['vertices']) for part in meshes])
low, high = all_vertices.min(axis=0), all_vertices.max(axis=0)
center = np.array([(low[0]+high[0])/2, low[1], (low[2]+high[2])/2])
scale = 4.7 / (high[2]-low[2])
for part in meshes:
    part['vertices'] = ((np.asarray(part['vertices'])-center)*scale).round(6).tolist()
with open(sys.argv[2], 'w') as output:
    json.dump(meshes, output, separators=(',', ':'))
print('Prepared',len(meshes),'parts,',sum(len(part['faces'])//3 for part in meshes),'triangles')
