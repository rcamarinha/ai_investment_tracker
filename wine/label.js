/**
 * Label recognition service — camera capture + AI Vision.
 *
 * Flow:
 *   User picks file / captures photo
 *   → fileToBase64() converts it
 *   → recognizeLabel() sends base64 image to Gemini Vision (primary)
 *     or Claude Vision (fallback if Gemini unavailable)
 *   → AI returns structured JSON with wine details
 *   → Caller pre-fills the Add Bottle dialog
 */

import { callWineAI } from './api.js?v=1.3.20';

// ── Label Recognition ────────────────────────────────────────────────────────

/**
 * Send a base64-encoded wine label image to Gemini Vision (primary) or Claude Vision (fallback) and return structured data.
 * @param {string} imageBase64 - Pure base64 string (no data URI prefix)
 * @param {string} mediaType   - MIME type, e.g. 'image/jpeg'
 * @returns {Promise<Object>}  - Parsed wine data object
 */
export async function recognizeLabel(imageBase64, mediaType = 'image/jpeg') {
    const prompt = `Analyze this wine label image carefully and extract all visible information.
Return ONLY a valid JSON object with exactly these fields (use null for any field not visible or determinable):

{
  "name": "full wine name as it appears on the label",
  "winery": "producer or winery name",
  "vintage": 2020,
  "region": "wine region (e.g. Bordeaux, Napa Valley, Tuscany, Rioja)",
  "appellation": "specific appellation or sub-region if visible",
  "varietal": "grape variety or blend description",
  "country": "country of origin",
  "alcohol": "alcohol percentage as string e.g. 13.5%",
  "bottleSize": "bottle format as one of: 0.375L, 0.75L, 1.5L, 3.0L, 4.5L, 6.0L, 9.0L, 12.0L, 15.0L — look for text like 75cl, 750ml, 1.5L, Magnum, Double Magnum, Jeroboam, Imperial, Methuselah on the label; return null if not visible",
  "notes": "any other notable text from the label (awards, special designations, classification, producer description)"
}

Return ONLY the JSON object. No markdown fences, no explanation, no preamble.`;

    const data = await callWineAI({
        requestType: 'label',
        prompt,
        image: { base64: imageBase64, mediaType },
        maxTokens: 1024,
    });

    const text = data.content?.find(c => c.type === 'text')?.text || '';
    const cleanText = text.replace(/```json\n?|```/g, '').trim();

    try {
        return JSON.parse(cleanText);
    } catch {
        throw new Error('Could not parse wine data from label. Try a clearer photo of the front label.');
    }
}

// ── File / Camera Helpers ────────────────────────────────────────────────────

/**
 * Convert a File object to a base64 string + media type.
 * @param {File} file
 * @returns {Promise<{base64: string, mediaType: string}>}
 */
export function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            // reader.result = "data:image/jpeg;base64,XXXX..."
            const parts = reader.result.split(',');
            const base64 = parts[1];
            resolve({ base64, mediaType: file.type || 'image/jpeg' });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Resize and compress a File image before label scanning.
 * Caps the longest side at 1600 px and re-encodes as JPEG at 0.85 quality,
 * keeping the payload well under Supabase edge-function worker limits.
 * Returns the same shape as captureVideoFrame: { base64, mediaType, dataUrl }.
 * @param {File} file
 * @returns {Promise<{base64: string, mediaType: string, dataUrl: string}>}
 */
export async function compressImageForLabel(file) {
    const MAX_PX  = 1600;
    const QUALITY = 0.85;

    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload  = () => resolve(el);
            el.onerror = reject;
            el.src = objectUrl;
        });

        let { naturalWidth: w, naturalHeight: h } = img;
        if (w > MAX_PX || h > MAX_PX) {
            const scale = MAX_PX / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
        const base64  = dataUrl.split(',')[1];
        return { base64, mediaType: 'image/jpeg', dataUrl };
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

/**
 * Capture a frame from a <video> element into a canvas and return base64.
 * @param {HTMLVideoElement} videoEl
 * @param {HTMLCanvasElement} canvasEl
 * @returns {{base64: string, mediaType: string, dataUrl: string}}
 */
export function captureVideoFrame(videoEl, canvasEl) {
    canvasEl.width  = videoEl.videoWidth  || 640;
    canvasEl.height = videoEl.videoHeight || 480;
    const ctx = canvasEl.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    const dataUrl = canvasEl.toDataURL('image/jpeg', 0.92);
    const base64  = dataUrl.split(',')[1];
    return { base64, mediaType: 'image/jpeg', dataUrl };
}
