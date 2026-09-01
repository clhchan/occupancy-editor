import { CELL_FREE, CELL_OCCUPIED, CELL_UNKNOWN, type GridData, type GridMetadata } from '../types';

export interface ParsedPgm {
    width: number;
    height: number;
    pixels: Uint8Array;
}

const DEFAULT_METADATA: GridMetadata = {
    image: 'map.pgm',
    resolution: 0.05,
    origin: { x: 0, y: 0, theta: 0 },
    negate: 0,
    occupied_thresh: 0.65,
    free_thresh: 0.196,
    mode: 'trinary',
};

const MAX_PGM_PIXELS = 16_000_000;

function parseRequiredNumber(value: string | null, key: string, predicate: (number: number) => boolean = Number.isFinite): number {
    if (value === null) throw new Error(`YAML 缺少 ${key}`);
    const parsed = Number(value);
    if (!predicate(parsed)) throw new Error(`YAML 字段 ${key} 无效`);
    return parsed;
}

export function parseMapYaml(text: string): GridMetadata {
    const metadata: GridMetadata = {
        ...DEFAULT_METADATA,
        origin: { ...DEFAULT_METADATA.origin },
    };
    const scalar = (key: string): string | null => {
        const match = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'mi'));
        if (!match) return null;
        return match[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
    };

    const image = scalar('image');
    if (image) metadata.image = image;
    metadata.resolution = parseRequiredNumber(scalar('resolution'), 'resolution', (value) => Number.isFinite(value) && value > 0);
    const origin = scalar('origin');
    if (origin === null) throw new Error('YAML 缺少 origin');
    const values = origin.replace(/^\[/, '').replace(/\]$/, '').split(',').map(Number);
    if (values.length !== 3 || !values.every(Number.isFinite)) throw new Error('YAML 字段 origin 无效');
    metadata.origin = { x: values[0], y: values[1], theta: values[2] };
    for (const key of ['negate', 'occupied_thresh', 'free_thresh'] as const) {
        const raw = scalar(key);
        if (raw === null) continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new Error(`YAML 字段 ${key} 无效`);
        if (key === 'negate' && value !== 0 && value !== 1) throw new Error('YAML 字段 negate 必须为 0 或 1');
        if (key !== 'negate' && (value < 0 || value > 1)) throw new Error(`YAML 字段 ${key} 必须在 0 到 1 之间`);
        metadata[key] = value;
    }
    if ((metadata.occupied_thresh ?? 0.65) <= (metadata.free_thresh ?? 0.196)) {
        throw new Error('YAML 字段 occupied_thresh 必须大于 free_thresh');
    }
    const mode = scalar('mode');
    if (mode) {
        if (!['trinary', 'scale', 'raw'].includes(mode)) throw new Error(`YAML mode 不支持: ${mode}`);
        metadata.mode = mode;
    }
    return metadata;
}

export function parsePgm(buffer: ArrayBuffer): ParsedPgm {
    const bytes = new Uint8Array(buffer);
    const decoder = new TextDecoder();
    let offset = 0;
    const nextToken = (): string => {
        while (offset < bytes.length) {
            const byte = bytes[offset];
            if (byte === 35) {
                while (offset < bytes.length && bytes[offset] !== 10) offset += 1;
            } else if (byte <= 32) {
                offset += 1;
            } else {
                break;
            }
        }
        const start = offset;
        while (offset < bytes.length && bytes[offset] > 32 && bytes[offset] !== 35) offset += 1;
        if (start === offset) throw new Error('PGM header is invalid');
        return decoder.decode(bytes.subarray(start, offset));
    };

    const magic = nextToken();
    if (magic !== 'P2' && magic !== 'P5') throw new Error('Only P2/P5 PGM files are supported');
    const width = Number(nextToken());
    const height = Number(nextToken());
    const maxValue = Number(nextToken());
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !Number.isInteger(maxValue) || maxValue <= 0 || maxValue > 65535) {
        throw new Error('PGM dimensions or gray range are invalid');
    }

    if (width > MAX_PGM_PIXELS || height > MAX_PGM_PIXELS || width > Math.floor(MAX_PGM_PIXELS / height)) {
        throw new Error(`PGM 图像过大，最多支持 ${MAX_PGM_PIXELS.toLocaleString()} 个像素`);
    }
    const count = width * height;
    const pixels = new Uint8Array(count);
    if (magic === 'P2') {
        for (let index = 0; index < count; index += 1) {
            const value = Number(nextToken());
            if (!Number.isFinite(value)) throw new Error('P2 pixel data is incomplete');
            pixels[index] = Math.max(0, Math.min(255, Math.round(value * 255 / maxValue)));
        }
    } else {
        if (bytes[offset] === 13 && bytes[offset + 1] === 10) offset += 2;
        else if (bytes[offset] === 10 || bytes[offset] === 13 || bytes[offset] === 32 || bytes[offset] === 9) offset += 1;
        else throw new Error('P5 header is missing the pixel separator');
        if (maxValue <= 255) {
            if (bytes.length - offset < count) throw new Error('P5 pixel data is incomplete');
            for (let index = 0; index < count; index += 1) {
                pixels[index] = Math.round(bytes[offset + index] * 255 / maxValue);
            }
        } else {
            if (bytes.length - offset < count * 2) throw new Error('16-bit PGM pixel data is incomplete');
            for (let index = 0; index < count; index += 1) {
                const value = bytes[offset + index * 2] * 256 + bytes[offset + index * 2 + 1];
                pixels[index] = Math.max(0, Math.min(255, Math.round(value * 255 / maxValue)));
            }
        }
    }
    return { width, height, pixels };
}

export function pgmToGrid(parsed: ParsedPgm, metadata: GridMetadata): GridData {
    if (metadata.mode && metadata.mode !== 'trinary') {
        throw new Error(`当前仅支持 trinary 地图，暂不支持 ${metadata.mode} 模式`);
    }
    const result = new Int8Array(parsed.pixels.length);
    const occupied = metadata.occupied_thresh ?? DEFAULT_METADATA.occupied_thresh!;
    const free = metadata.free_thresh ?? DEFAULT_METADATA.free_thresh!;
    const negate = metadata.negate === 1;
    const occupiedGray = (negate ? occupied : 1 - occupied) * 255;
    const freeGray = (negate ? free : 1 - free) * 255;
    for (let index = 0; index < parsed.pixels.length; index += 1) {
        // PGM map_saver uses 205 as the canonical UNKNOWN sample. Preserve it
        // even when a source YAML uses a free threshold that would classify it
        // as FREE, otherwise opening and saving a map destroys its gray areas.
        const gray = parsed.pixels[index];
        if (gray === 205) {
            result[index] = CELL_UNKNOWN;
        } else {
            result[index] = negate
                ? (gray >= occupiedGray ? CELL_OCCUPIED : gray <= freeGray ? CELL_FREE : CELL_UNKNOWN)
                : (gray <= occupiedGray ? CELL_OCCUPIED : gray >= freeGray ? CELL_FREE : CELL_UNKNOWN);
        }
    }
    return result;
}

export function gridToPgm(data: GridData, width: number, height: number, metadata?: GridMetadata): Uint8Array {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.length !== width * height) {
        throw new Error('地图尺寸与栅格数据长度不一致');
    }
    const negate = metadata?.negate === 1;
    // Keep the canonical ROS UNKNOWN sample so source gray areas survive a
    // load/save cycle regardless of the map's configured thresholds.
    const unknownValue = 205;
    // P5 is the binary PGM variant used by nav2_map_server's map saver. It
    // preserves the same grayscale semantics as P2 while avoiding one text
    // token per cell and greatly reducing load/save overhead for large maps.
    const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
    const output = new Uint8Array(header.length + data.length);
    output.set(header);
    for (let index = 0; index < data.length; index += 1) {
        output[header.length + index] = data[index] === CELL_OCCUPIED
            ? (negate ? 255 : 0)
            : data[index] === CELL_UNKNOWN
                ? unknownValue
                : (negate ? 0 : 254);
    }
    return output;
}

export function gridToYaml(metadata: GridMetadata, imageFilename: string): string {
    const origin = metadata.origin;
    return [
        `image: ${imageFilename}`,
        `resolution: ${metadata.resolution}`,
        `origin: [${origin.x}, ${origin.y}, ${origin.theta}]`,
        `negate: ${metadata.negate ?? 0}`,
        `occupied_thresh: ${metadata.occupied_thresh ?? 0.65}`,
        `free_thresh: ${metadata.free_thresh ?? 0.196}`,
        // gridToPgm serializes the editor's three states, so never advertise
        // scale/raw semantics that cannot be represented by GridData.
        `mode: trinary`,
        '',
    ].join('\n');
}
