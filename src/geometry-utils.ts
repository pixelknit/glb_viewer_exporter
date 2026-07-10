import * as THREE from 'three'

function createGeometry(geomType: string): THREE.Mesh{
  const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshStandardMaterial({
          color: '#444444',
          metalness: 0,
          roughness: 0.5
      })
  );

  switch(geomType){
    case "floor":
      return floor;
  }
}

export { createGeometry };
