const MAX_SIZE = 64;

function distance(a, b) {
    return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/**
 * Select a representative cover color from ImageData-compatible RGBA data.
 * Population is the main signal, so a small vivid logo cannot outrank a broad
 * colored region merely by being more saturated. Neutral, transparent and near
 * black/white pixels do not provide a useful accent; an empty palette returns null.
 * Histogram buckets retain actual channel sums rather than quantized centers,
 * preserving a solid cover's original color without artificial saturation.
 * @param {{data: ArrayLike<number>, width: number, height: number}} imageData
 * @returns {string|null}
 */
export function selectCoverColor(imageData) {
    const { data, width, height } = imageData || {};
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        return null;
    }
    if (!data || !Number.isSafeInteger(width * height * 4) || data.length < width * height * 4) {
        return null;
    }

    const scale = Math.min(1, MAX_SIZE / Math.max(width, height));
    const sampleWidth = Math.max(1, Math.round(width * scale));
    const sampleHeight = Math.max(1, Math.round(height * scale));
    const histogram = new Map();
    for (let y = 0; y < sampleHeight; y++) {
        for (let x = 0; x < sampleWidth; x++) {
            const sourceX = Math.min(width - 1, Math.floor(((x + 0.5) * width) / sampleWidth));
            const sourceY = Math.min(height - 1, Math.floor(((y + 0.5) * height) / sampleHeight));
            const offset = (sourceY * width + sourceX) * 4;
            const [r, g, b, alpha] = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
            if (![r, g, b, alpha].every((value) => Number.isFinite(value) && value >= 0 && value <= 255)) {
                continue;
            }
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            if (alpha < 128 || max < 24 || min > 235 || max - min < 12 || (max - min) / max < 0.08) {
                continue;
            }
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            const bucket = histogram.get(key) || { r: 0, g: 0, b: 0, count: 0, key };
            const weight = alpha / 255;
            bucket.r += r * weight;
            bucket.g += g * weight;
            bucket.b += b * weight;
            bucket.count += weight;
            histogram.set(key, bucket);
        }
    }
    const points = [...histogram.values()].sort((a, b) => b.count - a.count || a.key - b.key);
    for (const point of points) {
        point.r /= point.count;
        point.g /= point.count;
        point.b /= point.count;
    }
    if (!points.length) {
        return null;
    }

    // Frequency-weighted farthest seeds make repeated runs stable while giving
    // substantial, distinct color regions their own cluster (at most eight).
    let centers = [{ ...points[0] }];
    while (centers.length < Math.min(8, points.length)) {
        let selected = null;
        let best = 0;
        for (const point of points) {
            const score = point.count * Math.min(...centers.map((center) => distance(point, center)));
            if (score > best) {
                best = score;
                selected = point;
            }
        }
        if (!selected) {
            break;
        }
        centers.push({ ...selected });
    }
    for (let iteration = 0; iteration < 8; iteration++) {
        const sums = centers.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
        for (const point of points) {
            let nearest = 0;
            for (let i = 1; i < centers.length; i++) {
                if (distance(point, centers[i]) < distance(point, centers[nearest])) {
                    nearest = i;
                }
            }
            const sum = sums[nearest];
            sum.r += point.r * point.count;
            sum.g += point.g * point.count;
            sum.b += point.b * point.count;
            sum.count += point.count;
        }
        centers = sums
            .filter((sum) => sum.count)
            .map((sum) => ({
                r: sum.r / sum.count,
                g: sum.g / sum.count,
                b: sum.b / sum.count,
                count: sum.count
            }));
    }
    let winner = centers[0];
    let best = -1;
    for (const center of centers) {
        const max = Math.max(center.r, center.g, center.b);
        const saturation = (max - Math.min(center.r, center.g, center.b)) / max;
        const score = center.count * (0.45 + 0.55 * saturation);
        if (score > best) {
            best = score;
            winner = center;
        }
    }
    return (
        '#' +
        [winner.r, winner.g, winner.b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')
    );
}

/**
 * Sample a loaded image on a small canvas. Unloaded images, unavailable canvas
 * contexts fall back to the default theme. Canvas read errors propagate to the
 * loader so a transient CORS failure is not cached as a colorless cover.
 * @param {HTMLImageElement} image
 * @returns {string|null}
 */
export function getCoverColorFromImage(image) {
    const width = image?.naturalWidth;
    const height = image?.naturalHeight;
    if (!width || !height || typeof document === 'undefined') {
        return null;
    }
    const scale = Math.min(1, MAX_SIZE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return null;
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return selectCoverColor(context.getImageData(0, 0, canvas.width, canvas.height));
}
