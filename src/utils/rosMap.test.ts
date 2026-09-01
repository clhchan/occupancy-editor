import { describe, expect, it } from 'vitest';
import { CELL_FREE, CELL_OCCUPIED, CELL_UNKNOWN } from '../types';
import { gridToPgm, gridToYaml, parseMapYaml, parsePgm, pgmToGrid } from './rosMap';

describe('ROS map layers', () => {
    it('round-trips the occupancy values used by the editor', () => {
        const source = new Int8Array([CELL_OCCUPIED, CELL_FREE, CELL_UNKNOWN]);
        const pgm = gridToPgm(source, 3, 1);
        expect(new TextDecoder().decode(pgm.subarray(0, 11))).toBe('P5\n3 1\n255\n');
        const parsed = parsePgm(pgm.buffer);
        const metadata = parseMapYaml(gridToYaml({
            resolution: 0.05,
            origin: { x: -1.25, y: 2.5, theta: 0.2 },
            occupied_thresh: 0.65,
            free_thresh: 0.196,
            negate: 0,
        }, 'keepout_mask.pgm'));

        expect(metadata.origin).toEqual({ x: -1.25, y: 2.5, theta: 0.2 });
        expect(pgmToGrid(parsed, metadata)).toEqual(source);
    });

    it('round-trips trinary data when negate is enabled', () => {
        const source = new Int8Array([CELL_OCCUPIED, CELL_FREE, CELL_UNKNOWN]);
        const metadata = {
            resolution: 0.05,
            origin: { x: 0, y: 0, theta: 0 },
            negate: 1,
            occupied_thresh: 0.65,
            free_thresh: 0.196,
            mode: 'trinary',
        };
        const parsed = parsePgm(gridToPgm(source, 3, 1, metadata).buffer);
        expect(pgmToGrid(parsed, metadata)).toEqual(source);
        expect(parseMapYaml(gridToYaml(metadata, 'map.pgm')).negate).toBe(1);
    });

    it('preserves the canonical ROS gray unknown sample with custom thresholds', () => {
        const metadata = {
            resolution: 0.05,
            origin: { x: 0, y: 0, theta: 0 },
            negate: 0,
            occupied_thresh: 0.65,
            free_thresh: 0.25,
            mode: 'trinary',
        };
        const parsed = { width: 2, height: 1, pixels: new Uint8Array([205, 254]) };

        expect(pgmToGrid(parsed, metadata)).toEqual(new Int8Array([CELL_UNKNOWN, CELL_FREE]));
        expect(parsePgm(gridToPgm(new Int8Array([CELL_UNKNOWN]), 1, 1, metadata).buffer).pixels[0]).toBe(205);
    });

    it('scales binary P5 samples using maxValue', () => {
        const header = new TextEncoder().encode('P5\n1 1\n100\n');
        const buffer = new Uint8Array(header.length + 1);
        buffer.set(header);
        buffer[header.length] = 100;
        expect(parsePgm(buffer.buffer).pixels[0]).toBe(255);
    });

    it('rejects malformed metadata and unsupported map modes', () => {
        expect(() => parseMapYaml('image: map.pgm\nresolution: nope\norigin: [0, 0, 0]\n')).toThrow();
        expect(() => parseMapYaml('image: map.pgm\nresolution: 0.05\norigin: [0, 0, 0]\noccupied_thresh: 0.2\nfree_thresh: 0.2\n')).toThrow();
        expect(() => pgmToGrid({ width: 1, height: 1, pixels: new Uint8Array([0]) }, {
            resolution: 0.05,
            origin: { x: 0, y: 0, theta: 0 },
            mode: 'scale',
        })).toThrow();
    });

    it('rejects oversized PGM headers before allocating pixel data', () => {
        const header = new TextEncoder().encode('P5\n5000 5000\n255\n');
        expect(() => parsePgm(header.buffer)).toThrow(/过大/);
    });

    it('keeps mask output independent from the source map filename', () => {
        const yaml = gridToYaml({
            resolution: 0.1,
            origin: { x: -1, y: 2, theta: 0 },
            negate: 0,
        }, 'keepout_mask.pgm');

        expect(yaml).toContain('image: keepout_mask.pgm');
        expect(yaml).toContain('resolution: 0.1');
        expect(yaml).not.toContain('image: map.pgm');
    });
});
