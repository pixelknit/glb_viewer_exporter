import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import GUI from 'lil-gui'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createGeometry } from './geometry-utils.ts'

/**
 * Loaders
 */
const gltfLoader = new GLTFLoader();
const textureLoader = new THREE.TextureLoader();
const cubeTextureLoader = new THREE.CubeTextureLoader();

/**
 * Base
 */
// Debug
const gui = new GUI();
const debugObject = {};

// Canvas
const canvas = document.querySelector('canvas.webgl');

// Scene
const scene = new THREE.Scene();

const updateAllMaterials = () =>
{
    scene.traverse((child) =>
    {
        if(child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial)
        {
            // child.material.envMap = environmentMap
            child.material.envMapIntensity = debugObject.envMapIntensity;
            child.material.needsUpdate = true;
            child.castShadow = true;
            child.receiveShadow = true;
        }
    })
};

/**
 * Environment map
 */
const environmentMap = cubeTextureLoader.load([
    '/textures/environmentMap/px.jpg',
    '/textures/environmentMap/nx.jpg',
    '/textures/environmentMap/py.jpg',
    '/textures/environmentMap/ny.jpg',
    '/textures/environmentMap/pz.jpg',
    '/textures/environmentMap/nz.jpg'
]);

environmentMap.colorSpace = THREE.SRGBColorSpace;

// scene.background = environmentMap
scene.environment = environmentMap;

debugObject.envMapIntensity = 0.4;
gui.add(debugObject, 'envMapIntensity').min(0).max(4).step(0.001).onChange(updateAllMaterials);

/**
 * Models
 */
let droppedModel: THREE.Object3D | null = null;

const loadGltfIntoScene = (gltf: { scene: THREE.Object3D }) =>
{
    if(droppedModel)
    {
        scene.remove(droppedModel);
    }

    droppedModel = gltf.scene;
    scene.add(droppedModel);
    updateAllMaterials();
};

const readDirectoryEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));

const readEntry = async (entry: FileSystemEntry, relativePath: string, out: Map<string, File>) =>
{
    if(entry.isFile)
    {
        const file = await new Promise<File>((resolve, reject) =>
            (entry as FileSystemFileEntry).file(resolve, reject)
        );
        out.set(relativePath + entry.name, file);
    }
    else if(entry.isDirectory)
    {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        let batch: FileSystemEntry[];
        const children: FileSystemEntry[] = [];

        do
        {
            batch = await readDirectoryEntries(reader);
            children.push(...batch);
        }
        while(batch.length > 0);

        await Promise.all(children.map((child) => readEntry(child, `${relativePath}${entry.name}/`, out)));
    }
};

const collectDroppedFiles = async (dataTransfer: DataTransfer): Promise<Map<string, File>> =>
{
    const filesByPath = new Map<string, File>();
    const entries = [...dataTransfer.items]
        .map((item) => item.webkitGetAsEntry?.())
        .filter((entry): entry is FileSystemEntry => !!entry);

    if(entries.length > 0)
    {
        await Promise.all(entries.map((entry) => readEntry(entry, '', filesByPath)));
    }
    else
    {
        for(const file of dataTransfer.files)
        {
            filesByPath.set(file.name, file);
        }
    }

    return filesByPath;
};

const findFile = (
    filesByPath: Map<string, File>,
    filesByBaseName: Map<string, File>,
    uri: string
): File | undefined =>
{
    const decodedUri = decodeURIComponent(uri).replace(/^\.\//, '');
    const baseName = decodedUri.split('/').pop() ?? decodedUri;

    return filesByPath.get(decodedUri)
        ?? filesByBaseName.get(baseName)
        ?? filesByBaseName.get(baseName.toLowerCase());
};

const findMissingCompanionFiles = (
    gltfJson: { buffers?: { uri?: string }[]; images?: { uri?: string }[] },
    filesByPath: Map<string, File>,
    filesByBaseName: Map<string, File>
): string[] =>
{
    const referencedUris = [
        ...(gltfJson.buffers ?? []).map((buffer) => buffer.uri),
        ...(gltfJson.images ?? []).map((image) => image.uri)
    ].filter((uri): uri is string => !!uri && !uri.startsWith('data:'));

    return referencedUris.filter((uri) => !findFile(filesByPath, filesByBaseName, uri));
};

const loadGltfFromFiles = (filesByPath: Map<string, File>) =>
{
    const filesByBaseName = new Map<string, File>();
    for(const [path, file] of filesByPath)
    {
        const baseName = path.split('/').pop() ?? path;
        filesByBaseName.set(baseName, file);
        filesByBaseName.set(baseName.toLowerCase(), file);
    }

    const mainFile = [...filesByPath.values()].find((file) =>
        /\.(gltf|glb)$/i.test(file.name)
    );

    if(!mainFile)
    {
        console.warn('No .gltf or .glb file found in the dropped files');
        return;
    }

    const objectUrls: string[] = [];
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) =>
    {
        // Already-resolved URLs (e.g. blob: URLs GLTFLoader creates for embedded
        // GLB images) don't need to be looked up in the dropped files.
        if(/^(blob|data|https?):/i.test(url))
        {
            return url;
        }

        const matchedFile = findFile(filesByPath, filesByBaseName, url);

        if(matchedFile)
        {
            const objectUrl = URL.createObjectURL(matchedFile);
            objectUrls.push(objectUrl);
            return objectUrl;
        }

        console.warn(`Could not resolve "${url}" from the dropped files`);
        return url;
    });

    const loader = new GLTFLoader(manager);
    const reader = new FileReader();

    reader.onload = () =>
    {
        const onFinished = () => objectUrls.forEach((url) => URL.revokeObjectURL(url));

        if(/\.glb$/i.test(mainFile.name))
        {
            loader.parse(reader.result as ArrayBuffer, '', (gltf) =>
            {
                loadGltfIntoScene(gltf);
                onFinished();
            }, (error) => console.error('Failed to load glb', error));
        }
        else
        {
            const gltfText = reader.result as string;
            const missing = findMissingCompanionFiles(JSON.parse(gltfText), filesByPath, filesByBaseName);

            if(missing.length > 0)
            {
                console.error(
                    `Cannot load "${mainFile.name}": missing companion file(s) referenced by the model: ${missing.join(', ')}. ` +
                    'Drag the .gltf together with its .bin file and textures (or the whole model folder), or use a .glb instead.'
                );
                return;
            }

            loader.parse(gltfText, '', (gltf) =>
            {
                loadGltfIntoScene(gltf);
                onFinished();
            }, (error) => console.error('Failed to load gltf', error));
        }
    };

    if(/\.glb$/i.test(mainFile.name))
    {
        reader.readAsArrayBuffer(mainFile);
    }
    else
    {
        reader.readAsText(mainFile);
    }
};

/**
 * Drag and drop
 */
const dropOverlay = document.querySelector('.drop-overlay');
let dragDepth = 0;

window.addEventListener('dragenter', (event) =>
{
    event.preventDefault();
    dragDepth++;
    dropOverlay?.classList.add('visible');
});

window.addEventListener('dragover', (event) =>
{
    event.preventDefault();
});

window.addEventListener('dragleave', (event) =>
{
    event.preventDefault();
    dragDepth--;
    if(dragDepth <= 0)
    {
        dragDepth = 0;
        dropOverlay?.classList.remove('visible');
    }
});

window.addEventListener('drop', (event) =>
{
    event.preventDefault();
    dragDepth = 0;
    dropOverlay?.classList.remove('visible');

    if(event.dataTransfer)
    {
        collectDroppedFiles(event.dataTransfer).then(loadGltfFromFiles);
    }
});

/**
 * Export as OBJ + MTL + textures
 */
declare global
{
    interface Window
    {
        showDirectoryPicker(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
    }
}

const sanitizeFileName = (name: string) => name.replace(/[^a-z0-9_-]/gi, '_');

const writeFile = async (dirHandle: FileSystemDirectoryHandle, name: string, contents: string | Blob) =>
{
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
};

const textureToPngBlob = (texture: THREE.Texture): Promise<Blob> =>
{
    const image = texture.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
    const width = 'naturalWidth' in image ? (image.naturalWidth || image.width) : image.width;
    const height = 'naturalHeight' in image ? (image.naturalHeight || image.height) : image.height;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if(!context)
    {
        return Promise.reject(new Error('Could not create 2D context to export texture'));
    }

    context.drawImage(image as CanvasImageSource, 0, 0, width, height);

    return new Promise((resolve, reject) =>
    {
        canvas.toBlob((blob) =>
        {
            if(blob)
            {
                resolve(blob);
            }
            else
            {
                reject(new Error('Failed to encode texture as PNG'));
            }
        }, 'image/png');
    });
};

type ExportedMaterial = { name: string; material: THREE.MeshStandardMaterial };

const exportModelAsObj = async (object: THREE.Object3D) =>
{
    if(!window.showDirectoryPicker)
    {
        console.error('Your browser does not support the File System Access API (showDirectoryPicker). Try Chrome or Edge.');
        return;
    }

    const materialsByUuid = new Map<string, ExportedMaterial>();
    let materialCounter = 0;

    const vertex = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const uv = new THREE.Vector2();
    const normalMatrix = new THREE.Matrix3();

    let indexVertex = 0;
    let indexUv = 0;
    let indexNormal = 0;
    let objOutput = 'mtllib model.mtl\n';

    object.traverse((child) =>
    {
        if(!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.MeshStandardMaterial))
        {
            return;
        }

        const mesh = child;
        const material = mesh.material;

        let exportedMaterial = materialsByUuid.get(material.uuid);
        if(!exportedMaterial)
        {
            const name = material.name ? sanitizeFileName(material.name) : `material_${materialCounter++}`;
            exportedMaterial = { name, material };
            materialsByUuid.set(material.uuid, exportedMaterial);
        }

        const geometry = mesh.geometry;
        const positions = geometry.getAttribute('position');
        const normals = geometry.getAttribute('normal');
        const uvs = geometry.getAttribute('uv');
        const indices = geometry.getIndex();

        objOutput += `o ${mesh.name || exportedMaterial.name}\n`;
        objOutput += `usemtl ${exportedMaterial.name}\n`;

        for(let i = 0; i < positions.count; i++)
        {
            vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
            objOutput += `v ${vertex.x} ${vertex.y} ${vertex.z}\n`;
        }

        if(uvs)
        {
            // glTF textures are sampled with a flipped V; compensate here so the
            // exported OBJ/MTL renders right-side-up when reloaded elsewhere.
            for(let i = 0; i < uvs.count; i++)
            {
                uv.fromBufferAttribute(uvs, i);
                objOutput += `vt ${uv.x} ${1 - uv.y}\n`;
            }
        }

        if(normals)
        {
            normalMatrix.getNormalMatrix(mesh.matrixWorld);
            for(let i = 0; i < normals.count; i++)
            {
                normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
                objOutput += `vn ${normal.x} ${normal.y} ${normal.z}\n`;
            }
        }

        const writeFace = (a: number, b: number, c: number) =>
        {
            const face = [a, b, c].map((rawIndex) =>
            {
                const j = rawIndex + 1;
                const vIdx = indexVertex + j;
                const vtIdx = indexUv + j;
                const vnIdx = indexNormal + j;
                return `${vIdx}${uvs || normals ? '/' + (uvs ? vtIdx : '') + (normals ? '/' + vnIdx : '') : ''}`;
            });
            objOutput += `f ${face.join(' ')}\n`;
        };

        if(indices)
        {
            for(let i = 0; i < indices.count; i += 3)
            {
                writeFace(indices.getX(i), indices.getX(i + 1), indices.getX(i + 2));
            }
        }
        else
        {
            for(let i = 0; i < positions.count; i += 3)
            {
                writeFace(i, i + 1, i + 2);
            }
        }

        indexVertex += positions.count;
        indexUv += uvs ? uvs.count : 0;
        indexNormal += normals ? normals.count : 0;
    });

    if(materialsByUuid.size === 0)
    {
        console.warn('No exportable meshes found on the loaded model (expected THREE.Mesh with MeshStandardMaterial)');
        return;
    }

    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const texturesDir = await dirHandle.getDirectoryHandle('textures', { create: true });
    const textureFileNames = new Map<string, string>();

    const resolveTextureFile = async (texture: THREE.Texture | null, materialName: string, mapType: string): Promise<string | null> =>
    {
        if(!texture || !texture.image)
        {
            return null;
        }

        const existing = textureFileNames.get(texture.uuid);
        if(existing)
        {
            return existing;
        }

        const fileName = `${sanitizeFileName(materialName)}_${mapType}.png`;
        const blob = await textureToPngBlob(texture);
        await writeFile(texturesDir, fileName, blob);
        textureFileNames.set(texture.uuid, fileName);
        return fileName;
    };

    let mtlOutput = '';

    for(const { name, material } of materialsByUuid.values())
    {
        mtlOutput += `newmtl ${name}\n`;
        mtlOutput += `Kd ${material.color.r} ${material.color.g} ${material.color.b}\n`;
        mtlOutput += `d ${material.opacity}\n`;
        mtlOutput += 'illum 2\n';

        const baseColorFile = await resolveTextureFile(material.map, name, 'baseColor');
        if(baseColorFile) mtlOutput += `map_Kd textures/${baseColorFile}\n`;

        const normalFile = await resolveTextureFile(material.normalMap, name, 'normal');
        if(normalFile) mtlOutput += `norm textures/${normalFile}\n`;

        const roughnessFile = await resolveTextureFile(material.roughnessMap, name, 'roughness');
        if(roughnessFile) mtlOutput += `map_Pr textures/${roughnessFile}\n`;

        const metalnessFile = await resolveTextureFile(material.metalnessMap, name, 'metalness');
        if(metalnessFile) mtlOutput += `map_Pm textures/${metalnessFile}\n`;

        const emissiveFile = await resolveTextureFile(material.emissiveMap, name, 'emissive');
        if(emissiveFile) mtlOutput += `map_Ke textures/${emissiveFile}\n`;

        const alphaFile = await resolveTextureFile(material.alphaMap, name, 'alpha');
        if(alphaFile) mtlOutput += `map_d textures/${alphaFile}\n`;

        mtlOutput += '\n';
    }

    await writeFile(dirHandle, 'model.obj', objOutput);
    await writeFile(dirHandle, 'model.mtl', mtlOutput);

    console.log('Exported model.obj, model.mtl, and textures/ to the selected folder');
};

const exportControls = {
    exportObj: () =>
    {
        if(!droppedModel)
        {
            console.warn('No dropped model loaded to export. Drag a .gltf or .glb file in first.');
            return;
        }

        exportModelAsObj(droppedModel).catch((error) => console.error('Failed to export OBJ', error));
    }
};

gui.add(exportControls, 'exportObj').name('Export OBJ + textures');


/**
 * Lights
 */
const directionalLight = new THREE.DirectionalLight('#ffffff', 4);
directionalLight.castShadow = true;
directionalLight.shadow.camera.far = 15;
directionalLight.shadow.mapSize.set(1024, 1024);
directionalLight.shadow.normalBias = 0.05;
directionalLight.position.set(3.5, 2, - 1.25);
scene.add(directionalLight);

gui.add(directionalLight, 'intensity').min(0).max(10).step(0.001).name('lightIntensity');
gui.add(directionalLight.position, 'x').min(- 5).max(5).step(0.001).name('lightX');
gui.add(directionalLight.position, 'y').min(- 5).max(5).step(0.001).name('lightY');
gui.add(directionalLight.position, 'z').min(- 5).max(5).step(0.001).name('lightZ');

/**
 * Sizes
 */
const sizes = {
    width: window.innerWidth,
    height: window.innerHeight
};

window.addEventListener('resize', () =>
{
    // Update sizes
    sizes.width = window.innerWidth
    sizes.height = window.innerHeight

    // Update camera
    camera.aspect = sizes.width / sizes.height
    camera.updateProjectionMatrix()

    // Update renderer
    renderer.setSize(sizes.width, sizes.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
});

/**
 * Camera
 */
// Base camera
const camera = new THREE.PerspectiveCamera(35, sizes.width / sizes.height, 0.1, 100);
camera.position.set(2, 2, 2);
scene.add(camera);

// Controls
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.75, 0);
controls.enableDamping = true;

/**
 * Renderer
 */
const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true
});

renderer.toneMapping = THREE.CineonToneMapping;
renderer.toneMappingExposure = 1.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor('#211d20');
renderer.setSize(sizes.width, sizes.height);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
/**
 * Animate
 */
const clock = new THREE.Clock();
let previousTime = 0;

const tick = () =>
{
    const elapsedTime = clock.getElapsedTime();
    const deltaTime = elapsedTime - previousTime;
    previousTime = elapsedTime;

    // Update controls
    controls.update();

    // Render
    renderer.render(scene, camera);

    // Call tick again on the next frame
    window.requestAnimationFrame(tick);
};

tick();
