import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils.js";

type Point3D = {
  normal: [number, number, number];
  position: [number, number, number];
};

const ASCII_RAMP = " .,:;ox%#@";
const MOBILE_FRAME = { columns: 38, rows: 24 };
const DESKTOP_FRAME = { columns: 72, rows: 34 };

function normalizePoints(points: Point3D[]) {
  if (points.length === 0) return points;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    const [x, y, z] = point.position;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const scale = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;

  return points.map((point) => ({
    normal: point.normal,
    position: [
      (point.position[0] - centerX) / scale,
      (point.position[1] - centerY) / scale,
      (point.position[2] - centerZ) / scale
    ] as [number, number, number]
  }));
}

function parseBinaryStl(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const stride = 50;
  const availableTriangles = Math.floor((buffer.byteLength - 84) / stride);
  const count = Math.min(triangleCount, availableTriangles);
  const sampleEvery = Math.max(1, Math.ceil(count / 2400));
  const points: Point3D[] = [];

  for (let index = 0; index < count; index += sampleEvery) {
    const offset = 84 + index * stride;
    const normal: [number, number, number] = [
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true)
    ];

    const vertexA: [number, number, number] = [
      view.getFloat32(offset + 12, true),
      view.getFloat32(offset + 16, true),
      view.getFloat32(offset + 20, true)
    ];
    const vertexB: [number, number, number] = [
      view.getFloat32(offset + 24, true),
      view.getFloat32(offset + 28, true),
      view.getFloat32(offset + 32, true)
    ];
    const vertexC: [number, number, number] = [
      view.getFloat32(offset + 36, true),
      view.getFloat32(offset + 40, true),
      view.getFloat32(offset + 44, true)
    ];

    points.push({
      normal,
      position: [
        (vertexA[0] + vertexB[0] + vertexC[0]) / 3,
        (vertexA[1] + vertexB[1] + vertexC[1]) / 3,
        (vertexA[2] + vertexB[2] + vertexC[2]) / 3
      ]
    });
  }

  return normalizePoints(points);
}

function rotatePoint([x, y, z]: [number, number, number], yaw: number, pitch: number) {
  const yawCos = Math.cos(yaw);
  const yawSin = Math.sin(yaw);
  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);

  const yawX = x * yawCos - z * yawSin;
  const yawZ = x * yawSin + z * yawCos;

  return [
    yawX,
    y * pitchCos - yawZ * pitchSin,
    y * pitchSin + yawZ * pitchCos
  ] as const;
}

function renderAscii(points: Point3D[], columns: number, rows: number, time: number) {
  const grid = Array.from({ length: rows }, () => Array(columns).fill(" "));
  const depth = Array.from({ length: rows }, () => Array(columns).fill(Number.NEGATIVE_INFINITY));
  const yaw = time * 0.00055;
  const pitch = Math.sin(time * 0.00023) * 0.32 - 0.18;
  const stamp = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1]
  ] as const;

  for (const point of points) {
    const [rx, ry, rz] = rotatePoint(point.position, yaw, pitch);
    const [nx, ny, nz] = rotatePoint(point.normal, yaw, pitch);
    if (nz < 0.18) continue;
    if (
      Math.abs(point.position[0]) < 0.18 &&
      point.position[1] > 0.02 &&
      point.position[1] < 0.26 &&
      point.position[2] > -0.35
    ) {
      continue;
    }
    const projectedZ = rz + 2.4;
    const perspective = 1 / projectedZ;
    const column = Math.round(columns / 2 + rx * perspective * columns * 1.52);
    const row = Math.round(rows / 2 - ry * perspective * rows * 2.28);
    if (column < 0 || column >= columns || row < 0 || row >= rows) continue;

    const light = nx * -0.3 + ny * 0.25 + nz * 0.95;
    const brightness = Math.max(0, Math.min(1, light * 0.5 + 0.5));
    if (brightness < 0.32) continue;

    const glyphIndex = Math.max(
      0,
      Math.min(ASCII_RAMP.length - 1, Math.round(brightness * (ASCII_RAMP.length - 1)))
    );
    const glyph = ASCII_RAMP[glyphIndex];
    const stampOffsets = brightness > 0.55 ? stamp : ([stamp[0]] as const);
    if (glyph === " ") continue;

    for (const [dx, dy] of stampOffsets) {
      const targetColumn = column + dx;
      const targetRow = row + dy;
      if (targetColumn < 0 || targetColumn >= columns || targetRow < 0 || targetRow >= rows) continue;
      const depthRow = depth[targetRow];
      const gridRow = grid[targetRow];
      if (!depthRow || !gridRow) continue;
      if (projectedZ > depthRow[targetColumn]) {
        depthRow[targetColumn] = projectedZ;
        gridRow[targetColumn] = glyph;
      }
    }
  }

  return grid.map((line) => line.join("")).join("\n");
}

export function AsciiLogoViewer({
  className,
  preClassName
}: {
  className?: string;
  preClassName?: string;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [points, setPoints] = useState<Point3D[]>([]);
  const [asciiFrame, setAsciiFrame] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState(DESKTOP_FRAME);

  useEffect(() => {
    let cancelled = false;
    async function loadModel() {
      try {
        const response = await fetch("/Automa-NBG.stl");
        if (!response.ok) throw new Error(`Failed to load STL (${response.status})`);
        const buffer = await response.arrayBuffer();
        if (cancelled) return;
        setPoints(parseBinaryStl(buffer));
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load STL file.");
      }
    }
    loadModel();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const node = frameRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = entry.contentRect.width;
      setDimensions(width < 720 ? MOBILE_FRAME : DESKTOP_FRAME);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (points.length === 0) return;
    let frameId = 0;
    const tick = (time: number) => {
      setAsciiFrame(renderAscii(points, dimensions.columns, dimensions.rows, time));
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [dimensions.columns, dimensions.rows, points]);

  return (
    <div ref={frameRef} className={cn("relative flex items-center justify-center overflow-hidden p-4 sm:p-6", className)}>
      <pre
        className={cn(
          "relative mt-1 overflow-hidden bg-transparent font-mono text-[11px] leading-[0.84rem] font-black text-foreground sm:text-[13px] sm:leading-[0.94rem]",
          preClassName
        )}
      >
        {error
          ? `render failed\n${error}`
          : asciiFrame || "sampling triangles...\nprojecting logo...\nbooting viewport..."}
      </pre>
    </div>
  );
}
