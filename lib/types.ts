/** Every Magnific Cinematic ratio; labels and order in config/aspects.ts. */
export type AspectRatio = '1:1' | '4:5' | '9:16' | '3:4' | '2:3' | '4:3' | '3:2' | '5:4' | '16:9' | '21:9';
export type EnvMode = 'preset' | 'place-in-space' | 'inspired-by-space';
export type ModelId = 'cinematic';
export type Resolution = '2k' | '4k';
/** Optional Magnific Cinematic controls; a missing key or 'Auto' lets the model decide. */
export interface CinematicSettings {
  camera?: string; lensBrand?: string; focalLength?: string; aperture?: string;
  shotType?: string; filmStock?: string; movieLook?: string; lighting?: string;
  motionBlur?: string; grain?: string; halation?: string; tonalLook?: string;
}
export type UploadKind = 'product' | 'space';
export interface Box { x: number; y: number; w: number; h: number } // normalized 0..1
export interface UploadInfo { id: string; kind: UploadKind; file: string; width: number; height: number }
export interface CutoutInfo { id: string; sourceUploadId: string; file: string; width: number; height: number }
/** One product of the scene: a short name and 1–6 angle photos (cutouts), the first is the cover. */
export interface ProductInput { name: string; cutoutIds: string[] }
export interface GenerationRequest {
  /** 1–4 products, names unique (case-insensitive). Legacy records with `cutoutId` read as one product. */
  products: ProductInput[]; envMode: EnvMode; styleId?: string; spaceUploadId?: string;
  note?: string; aspect: AspectRatio; count: 1 | 2 | 3 | 4; model: ModelId;
  /** Output resolution; a request or legacy record without it means '2k'. */
  resolution: Resolution;
  /** Only the set (non-Otomatik) Cinematic controls. */
  cinematic?: CinematicSettings;
}
export type OutputStatus = 'pending' | 'done' | 'failed';
export interface GenerationOutput { index: number; status: OutputStatus; file?: string; error?: string }
export type GenerationStatus = 'running' | 'done' | 'partial' | 'failed';
export interface GenerationRecord extends GenerationRequest {
  id: string; createdAt: string; updatedAt: string; prompt: string;
  status: GenerationStatus; outputs: GenerationOutput[];
}
export interface SavedSpace { id: string; name: string; uploadId: string; file: string; createdAt: string }
