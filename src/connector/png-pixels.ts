// The PNG reader the level-3 pixel check (src/connector/conformance.ts) and the Office connector use. It is the published kit helper itself
// (public-kit/helpers/png.mjs, types in png.d.mts): one source, so outside connectors decode exactly as core does (migration K1).
// The relative path is the same from src/connector and dist/connector, and the package ships public-kit/ beside dist/.
export { decodePng, MAX_PIXEL_BYTES, sameRegion, sameRegionAt, type Pixels } from "../../public-kit/helpers/png.mjs";
