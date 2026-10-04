import { CELL_OCCUPIED, type GridData, type GridMetadata } from '../types';

// 家庭地点标记：把网页上标好的点位导出为 Nav2 可直接下发的 map 坐标系位姿。
// 像素与世界坐标的换算遵循 ROS 地图约定：图像第 0 行在最上方，origin 是地图
// 左下角在世界坐标系中的位置，因此行号方向与世界 y 轴方向相反。

export type PlacementStatus = 'ok' | 'blocked';

export interface Quaternion {
    x: number;
    y: number;
    z: number;
    w: number;
}

export interface WorldPoint {
    x: number;
    y: number;
}

export interface PixelPoint {
    col: number;
    row: number;
}

export interface Waypoint {
    id: string;
    name: string;
    aliases: string[];
    position: { x: number; y: number; z: number };
    orientation: Quaternion;
    yawDeg: number;
    pixel: PixelPoint;
    updatedAt: string;
}

export interface MapBinding {
    image: string;
    resolution: number;
    origin: [number, number, number];
    width: number;
    height: number;
}

export interface WaypointFile {
    version: number;
    frameId: string;
    mapBinding: MapBinding;
    waypoints: Waypoint[];
}

export interface PresetSlot {
    id: string;
    color: string;
}

// A–J 是编辑器卡片的槽位 ID；只有已标记的槽位会写入地点文件。
export const WAYPOINT_NAME_EXAMPLES = ['客厅', '厨房', '卧室', '卫生间', '充电桩'] as const;
export const EXAMPLE_SLOT_COUNT = WAYPOINT_NAME_EXAMPLES.length;
export const PRESET_SLOTS: readonly PresetSlot[] = [
    { id: 'A', color: '#2563eb' },
    { id: 'B', color: '#ea580c' },
    { id: 'C', color: '#7c3aed' },
    { id: 'D', color: '#0d9488' },
    { id: 'E', color: '#ca8a04' },
    { id: 'F', color: '#db2777' },
    { id: 'G', color: '#9333ea' },
    { id: 'H', color: '#0891b2' },
    { id: 'I', color: '#65a30d' },
    { id: 'J', color: '#475569' },
];

export function defaultSlotName(slotId: string): string {
    const index = PRESET_SLOTS.findIndex((slot) => slot.id === slotId);
    return WAYPOINT_NAME_EXAMPLES[index] || `地点 ${slotId}`;
}

export const WAYPOINTS_FILE_VERSION = 1;
export const WAYPOINTS_DEFAULT_FILENAME = 'waypoints.yaml';
export const WAYPOINTS_DEFAULT_FRAME = 'map';
// 地点标记箭头长度（米），随地图分辨率换算为栅格数。
export const MARKER_ARROW_LENGTH_M = 0.76;
// 拖拽不足该屏幕距离时不提交点位，避免导出没有朝向的点。
export const MIN_YAW_DRAG_PX = 10;

export function markerArrowCells(resolution: number, lengthMeters = MARKER_ARROW_LENGTH_M): number {
    if (!Number.isFinite(resolution) || resolution <= 0) return 15;
    return lengthMeters / resolution;
}

// 栅格中心 -> 世界坐标。origin.theta 通常为 0，非 0 时按地图原点旋转。
export function pixelToWorld(col: number, row: number, height: number, metadata: GridMetadata): WorldPoint {
    const localX = (col + 0.5) * metadata.resolution;
    const localY = (height - row - 0.5) * metadata.resolution;
    const theta = metadata.origin.theta || 0;
    if (!theta) {
        return { x: metadata.origin.x + localX, y: metadata.origin.y + localY };
    }
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    return {
        x: metadata.origin.x + localX * cos - localY * sin,
        y: metadata.origin.y + localX * sin + localY * cos,
    };
}

// 世界坐标 -> 栅格索引，pixelToWorld 的逆运算。
export function worldToPixel(x: number, y: number, height: number, metadata: GridMetadata): PixelPoint {
    const deltaX = x - metadata.origin.x;
    const deltaY = y - metadata.origin.y;
    const theta = metadata.origin.theta || 0;
    let localX = deltaX;
    let localY = deltaY;
    if (theta) {
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        localX = deltaX * cos + deltaY * sin;
        localY = -deltaX * sin + deltaY * cos;
    }
    return {
        col: Math.floor(localX / metadata.resolution),
        row: Math.floor(height - localY / metadata.resolution),
    };
}

// 画布行号向下增长，世界 y 轴向上，所以行差取反后再求方位角。
export function yawFromDrag(startCol: number, startRow: number, endCol: number, endRow: number): number {
    return Math.atan2(startRow - endRow, endCol - startCol);
}

export function yawToQuaternion(yaw: number): Quaternion {
    return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
}

export function quaternionToYaw(orientation: Quaternion): number {
    const { x, y, z, w } = orientation;
    return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

export function normalizeDegrees(degrees: number): number {
    const wrapped = degrees % 360;
    if (wrapped > 180) return wrapped - 360;
    if (wrapped <= -180) return wrapped + 360;
    return wrapped;
}

export interface PlacementReport {
    status: PlacementStatus;
    reason: string;
}

// 网页端只做最低限度的判定：落点必须在地图内的非占用（非黑色）栅格上。
// 机身碰撞、禁行区、可达性等一律交给导航侧解决。
export function evaluatePlacement(options: {
    col: number;
    row: number;
    width: number;
    height: number;
    mapData: GridData;
}): PlacementReport {
    const { col, row, width, height, mapData } = options;
    if (col < 0 || col >= width || row < 0 || row >= height) {
        return { status: 'blocked', reason: '目标点超出地图范围' };
    }
    if (mapData[row * width + col] === CELL_OCCUPIED) {
        return { status: 'blocked', reason: '这里是障碍物' };
    }
    return { status: 'ok', reason: '可以标记' };
}

export function createWaypoint(options: {
    id: string;
    name: string;
    aliases: string[];
    col: number;
    row: number;
    yawRad: number;
    height: number;
    metadata: GridMetadata;
    now?: Date;
}): Waypoint {
    const { id, name, aliases, col, row, yawRad, height, metadata } = options;
    const world = pixelToWorld(col, row, height, metadata);
    return {
        id,
        name,
        aliases: [...aliases],
        position: { x: world.x, y: world.y, z: 0 },
        orientation: yawToQuaternion(yawRad),
        yawDeg: normalizeDegrees((yawRad * 180) / Math.PI),
        pixel: { col, row },
        updatedAt: (options.now ?? new Date()).toISOString(),
    };
}

export function mapBindingFromMetadata(metadata: GridMetadata, width: number, height: number, image?: string): MapBinding {
    return {
        image: image || metadata.image || 'map.pgm',
        resolution: metadata.resolution,
        origin: [metadata.origin.x, metadata.origin.y, metadata.origin.theta ?? 0],
        width,
        height,
    };
}

// 重新建图后 origin 会变，旧点位必须作废重标，所以加载时硬校验绑定。
// 具体差在哪一项（文件名/尺寸/分辨率/原点）对用户没有操作差异，统一一条提示。
export function describeBindingMismatch(binding: MapBinding, metadata: GridMetadata, width: number, height: number, expectedImage?: string | null): string | null {
    if (expectedImage && binding.image && binding.image !== expectedImage) {
        return '地点文件与当前地图不匹配，请重新标注点位';
    }
    if (binding.width !== width || binding.height !== height) {
        return '地点文件与当前地图不匹配，请重新标注点位';
    }
    if (Math.abs(binding.resolution - metadata.resolution) > 1e-9) {
        return '地点文件与当前地图不匹配，请重新标注点位';
    }
    const currentOrigin: [number, number, number] = [metadata.origin.x, metadata.origin.y, metadata.origin.theta ?? 0];
    if (binding.origin.some((value, index) => Math.abs(value - currentOrigin[index]) > 1e-9)) {
        return '地点文件与当前地图不匹配，请重新标注点位';
    }
    return null;
}

function formatNumber(value: number, digits = 6): string {
    if (!Number.isFinite(value)) return '0';
    const fixed = value.toFixed(digits);
    if (!fixed.includes('.')) return fixed;
    return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

function quote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// 输出格式与 Nav2 的 PoseStamped 对齐：每个点位直接是 position/orientation
// 嵌套结构，下游程序读出即可填进 geometry_msgs.msg.Pose。
export function serializeWaypointsYaml(file: WaypointFile): string {
    const lines: string[] = [
        `version: ${file.version}`,
        `frame_id: ${file.frameId}`,
        `map: ${quote(file.mapBinding.image)}`,
        `resolution: ${formatNumber(file.mapBinding.resolution)}`,
        `origin: [${file.mapBinding.origin.map((value) => formatNumber(value)).join(', ')}]`,
        `size: [${file.mapBinding.width}, ${file.mapBinding.height}]`,
    ];
    if (!file.waypoints.length) {
        lines.push('waypoints: []', '');
        return lines.join('\n');
    }
    lines.push('waypoints:');
    const seenNames = new Set<string>();
    for (const waypoint of file.waypoints) {
        const name = waypoint.name.trim();
        if (!name) throw new Error(`${waypoint.id} 的 name 必须是非空字符串`);
        if (seenNames.has(name)) throw new Error(`地点名称不能重复: ${name}`);
        seenNames.add(name);
        lines.push(`  - id: ${quote(waypoint.id)}`);
        lines.push(`    name: ${quote(name)}`);
        lines.push('    pose:');
        lines.push(`      position: {x: ${formatNumber(waypoint.position.x)}, y: ${formatNumber(waypoint.position.y)}, z: 0.0}`);
        const orientation = waypoint.orientation;
        lines.push(`      orientation: {x: ${formatNumber(orientation.x)}, y: ${formatNumber(orientation.y)}, z: ${formatNumber(orientation.z)}, w: ${formatNumber(orientation.w)}}`);
    }
    lines.push('');
    return lines.join('\n');
}

// --- 最小 YAML 子集解析 ---
// 项目没有 YAML 依赖，rosMap.ts 用正则读扁平标量即可，但地点文件是嵌套结构，
// 正则不够用。这里只实现本文件格式需要的部分：缩进块、映射、序列、
// 行内 [] 与 {}、引号标量和数字。

type YamlNode = string | number | boolean | null | YamlNode[] | { [key: string]: YamlNode };

interface RawLine {
    indent: number;
    text: string;
}

function stripComment(line: string): string {
    let inSingle = false;
    let inDouble = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === "'" && !inDouble) inSingle = !inSingle;
        else if (character === '"' && !inSingle) inDouble = !inDouble;
        else if (character === '#' && !inSingle && !inDouble) {
            if (index === 0 || /\s/.test(line[index - 1])) return line.slice(0, index);
        }
    }
    return line;
}

function tokenizeYaml(text: string): RawLine[] {
    const lines: RawLine[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const withoutComment = stripComment(raw);
        const trimmed = withoutComment.trim();
        if (!trimmed || trimmed === '---' || trimmed === '...') continue;
        const leading = withoutComment.slice(0, withoutComment.length - withoutComment.trimStart().length);
        if (leading.includes('\t')) throw new Error('地点文件的缩进不能使用制表符');
        lines.push({ indent: leading.length, text: trimmed });
    }
    return lines;
}

function splitFlow(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let current = '';
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index];
        if (inDouble) {
            current += character;
            if (character === '"' && body[index - 1] !== '\\') inDouble = false;
            continue;
        }
        if (inSingle) {
            current += character;
            if (character === "'") inSingle = false;
            continue;
        }
        if (character === '"') {
            inDouble = true;
            current += character;
            continue;
        }
        if (character === "'") {
            inSingle = true;
            current += character;
            continue;
        }
        if (character === '[' || character === '{') depth += 1;
        else if (character === ']' || character === '}') depth -= 1;
        else if (character === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += character;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function parseFlowSequence(text: string): YamlNode[] {
    if (!text.endsWith(']')) throw new Error('地点文件的行内列表缺少右方括号');
    return splitFlow(text.slice(1, -1)).map(parseScalar);
}

function parseFlowMapping(text: string): { [key: string]: YamlNode } {
    if (!text.endsWith('}')) throw new Error('地点文件的行内字典缺少右花括号');
    const result: { [key: string]: YamlNode } = {};
    for (const part of splitFlow(text.slice(1, -1))) {
        const separator = findKeySeparator(part);
        if (separator < 0) throw new Error(`地点文件的行内字典格式无效: ${part}`);
        result[unquoteKey(part.slice(0, separator))] = parseScalar(part.slice(separator + 1));
    }
    return result;
}

function parseScalar(raw: string): YamlNode {
    const text = raw.trim();
    if (!text || text === '~' || text === 'null' || text === 'Null') return null;
    if (text === 'true' || text === 'True') return true;
    if (text === 'false' || text === 'False') return false;
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
        return text.slice(1, -1).replace(/''/g, "'");
    }
    if (text.startsWith('[')) return parseFlowSequence(text);
    if (text.startsWith('{')) return parseFlowMapping(text);
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) {
        const numeric = Number(text);
        if (Number.isFinite(numeric)) return numeric;
    }
    return text;
}

function findKeySeparator(line: string): number {
    let inSingle = false;
    let inDouble = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === "'" && !inDouble) inSingle = !inSingle;
        else if (character === '"' && !inSingle) inDouble = !inDouble;
        else if (character === ':' && !inSingle && !inDouble) {
            if (index + 1 >= line.length || /\s/.test(line[index + 1])) return index;
        }
    }
    return -1;
}

function unquoteKey(raw: string): string {
    const text = raw.trim();
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
        return text.slice(1, -1);
    }
    return text;
}

function isSequenceLine(text: string): boolean {
    return text === '-' || text.startsWith('- ');
}

function collectDeeper(lines: RawLine[], start: number, indent: number): { block: RawLine[]; next: number } {
    let index = start;
    while (index < lines.length && lines[index].indent > indent) index += 1;
    return { block: lines.slice(start, index), next: index };
}

function parseLines(lines: RawLine[]): YamlNode {
    if (!lines.length) return null;
    const indent = lines[0].indent;
    if (isSequenceLine(lines[0].text)) return parseSequence(lines, 0, indent).value;
    return parseMapping(lines, 0, indent).value;
}

function parseSequence(lines: RawLine[], start: number, indent: number): { value: YamlNode[]; next: number } {
    const items: YamlNode[] = [];
    let index = start;
    while (index < lines.length && lines[index].indent === indent && isSequenceLine(lines[index].text)) {
        const rest = lines[index].text === '-' ? '' : lines[index].text.slice(2).trim();
        const { block, next } = collectDeeper(lines, index + 1, indent);
        if (!rest) {
            items.push(block.length ? parseLines(block) : null);
        } else if (findKeySeparator(rest) >= 0 && !rest.startsWith('[') && !rest.startsWith('{')) {
            // 形如 "- id: A"：把它当成条目映射的第一行，
            // 后续更深缩进的行属于同一个条目。
            const firstIndent = block.length ? block[0].indent : indent + 2;
            items.push(parseLines([{ indent: firstIndent, text: rest }, ...block]));
        } else {
            items.push(parseScalar(rest));
        }
        index = next;
    }
    return { value: items, next: index };
}

function parseMapping(lines: RawLine[], start: number, indent: number): { value: { [key: string]: YamlNode }; next: number } {
    const result: { [key: string]: YamlNode } = {};
    let index = start;
    while (index < lines.length && lines[index].indent === indent && !isSequenceLine(lines[index].text)) {
        const line = lines[index].text;
        const separator = findKeySeparator(line);
        if (separator < 0) throw new Error(`地点文件无法解析这一行: ${line}`);
        const key = unquoteKey(line.slice(0, separator));
        const rest = line.slice(separator + 1).trim();
        index += 1;
        if (rest) {
            result[key] = parseScalar(rest);
            continue;
        }
        const { block, next } = collectDeeper(lines, index, indent);
        if (block.length) {
            result[key] = parseLines(block);
            index = next;
        } else if (index < lines.length && lines[index].indent === indent && isSequenceLine(lines[index].text)) {
            // 序列的短横线允许与键同级缩进。
            const sequence = parseSequence(lines, index, indent);
            result[key] = sequence.value;
            index = sequence.next;
        } else {
            result[key] = null;
        }
    }
    return { value: result, next: index };
}

function asRecord(value: YamlNode, label: string): { [key: string]: YamlNode } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`地点文件的 ${label} 格式无效`);
    return value as { [key: string]: YamlNode };
}

function asFiniteNumber(value: YamlNode, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`地点文件的 ${label} 不是有效数字`);
    return value;
}

function asText(value: YamlNode, label: string): string {
    if (typeof value === 'string' && value.trim()) return value.trim();
    throw new Error(`地点文件的 ${label} 必须是非空字符串`);
}

export function parseWaypointsYaml(text: string, height?: number, metadata?: GridMetadata): WaypointFile {
    const document = parseLines(tokenizeYaml(text));
    const root = asRecord(document, '根结构');

    const version = root.version === null || root.version === undefined ? WAYPOINTS_FILE_VERSION : asFiniteNumber(root.version, 'version');
    if (version !== WAYPOINTS_FILE_VERSION) {
        throw new Error(`地点文件版本 ${version} 不受支持，当前支持版本 ${WAYPOINTS_FILE_VERSION}`);
    }
    const frameId = root.frame_id === null || root.frame_id === undefined ? WAYPOINTS_DEFAULT_FRAME : asText(root.frame_id, 'frame_id');

    const binding: MapBinding = {
        image: root.map === null || root.map === undefined ? '' : asText(root.map, 'map'),
        resolution: asFiniteNumber(root.resolution, 'resolution'),
        origin: [0, 0, 0],
        width: 0,
        height: 0,
    };
    if (binding.resolution <= 0) throw new Error('地点文件的 resolution 必须大于 0');
    const originValue = root.origin;
    if (!Array.isArray(originValue) || originValue.length !== 3) throw new Error('地点文件的 origin 必须是 3 个数字');
    binding.origin = [
        asFiniteNumber(originValue[0], 'origin[0]'),
        asFiniteNumber(originValue[1], 'origin[1]'),
        asFiniteNumber(originValue[2], 'origin[2]'),
    ];
    const sizeValue = root.size;
    if (!Array.isArray(sizeValue) || sizeValue.length !== 2) throw new Error('地点文件的 size 必须是 [宽, 高]');
    binding.width = asFiniteNumber(sizeValue[0], 'size[0]');
    binding.height = asFiniteNumber(sizeValue[1], 'size[1]');
    if (!Number.isInteger(binding.width) || binding.width <= 0 || !Number.isInteger(binding.height) || binding.height <= 0) {
        throw new Error('地点文件的 size 必须是两个正整数');
    }

    // 像素位置以 x/y 为准重算，这样手工改过坐标的文件也能正确显示。
    const pixelHeight = height ?? binding.height;
    const pixelMetadata: GridMetadata = metadata ?? {
        resolution: binding.resolution,
        origin: { x: binding.origin[0], y: binding.origin[1], theta: binding.origin[2] },
    };

    const rawWaypoints = root.waypoints;
    if (rawWaypoints !== null && rawWaypoints !== undefined && !Array.isArray(rawWaypoints)) {
        throw new Error('地点文件的 waypoints 必须是列表');
    }
    const waypoints: Waypoint[] = [];
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const item of (rawWaypoints as YamlNode[] | null | undefined) ?? []) {
        const record = asRecord(item, 'waypoints 条目');
        const id = asText(record.id, 'waypoints 条目的 id');
        if (seenIds.has(id)) throw new Error(`地点文件存在重复的 id: ${id}`);
        seenIds.add(id);
        // pose 是 Nav2 对齐的 position/orientation 嵌套结构，地点必须包含 yaw。
        let x: number;
        let y: number;
        let orientation: Quaternion;
        const pose = record.pose === null || record.pose === undefined ? null : asRecord(record.pose, `${id} 的 pose`);
        if (pose) {
            const positionRecord = asRecord(pose.position, `${id} 的 pose.position`);
            const orientationRecord = asRecord(pose.orientation, `${id} 的 pose.orientation`);
            x = asFiniteNumber(positionRecord.x, `${id} 的 position.x`);
            y = asFiniteNumber(positionRecord.y, `${id} 的 position.y`);
            orientation = {
                x: asFiniteNumber(orientationRecord.x, `${id} 的 orientation.x`),
                y: asFiniteNumber(orientationRecord.y, `${id} 的 orientation.y`),
                z: asFiniteNumber(orientationRecord.z, `${id} 的 orientation.z`),
                w: asFiniteNumber(orientationRecord.w, `${id} 的 orientation.w`),
            };
            if (orientation.x === 0 && orientation.y === 0 && orientation.z === 0 && orientation.w === 0) {
                throw new Error(`${id} 的 pose.orientation 不能是零四元数`);
            }
        } else {
            // 兼容平铺 x/y 的旧格式。
            x = asFiniteNumber(record.x, `${id} 的 x`);
            y = asFiniteNumber(record.y, `${id} 的 y`);
            const yawRaw = record.yaw;
            if (yawRaw === null || yawRaw === undefined) throw new Error(`${id} 缺少 yaw，地点必须指定朝向`);
            const yawDeg = asFiniteNumber(yawRaw, `${id} 的 yaw`);
            orientation = yawToQuaternion((yawDeg * Math.PI) / 180);
        }
        const yawRad = quaternionToYaw(orientation);
        const name = asText(record.name, `${id} 的 name`);
        if (seenNames.has(name)) throw new Error(`地点文件存在重复的 name: ${name}`);
        seenNames.add(name);
        waypoints.push({
            id,
            name,
            aliases: [],
            position: { x, y, z: 0 },
            orientation,
            yawDeg: normalizeDegrees((yawRad * 180) / Math.PI),
            pixel: worldToPixel(x, y, pixelHeight, pixelMetadata),
            updatedAt: '',
        });
    }

    return { version, frameId, mapBinding: binding, waypoints };
}
