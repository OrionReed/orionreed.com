// units.ts — a tiny dimensional-analysis algebra.
//
// A `Unit` is `(factor, dim, offset)`: `factor` SI-base units per unit,
// a dimension exponent vector, and an `offset` for affine units (°C/°F).
// Units form a vector space under multiplication — `times`/`div` add and
// subtract dim vectors and multiply/divide factors, `pow` scales — so the
// whole zoo is built compositionally from seven base units. Affine units
// are leaves (they don't compose) and carry a nonzero `offset`.

// Seven SI base dimensions, plus two pragmatic tags (information, angle)
// so bytes and radians ride the same machinery. Angle is nominally
// dimensionless; the tag just keeps it from converting into a length.
export const DIM_SYMBOLS = ["m", "kg", "s", "A", "K", "mol", "cd", "B", "rad"] as const;
const NDIM = DIM_SYMBOLS.length;

type Dim = number[];
const zero = (): Dim => new Array(NDIM).fill(0);
const basis = (i: number): Dim => {
  const d = zero();
  d[i] = 1;
  return d;
};

export class Unit {
  constructor(
    readonly factor: number,
    readonly dim: Dim,
    readonly offset = 0,
    readonly symbol = "",
    readonly name = "",
  ) {}

  /** Value in this unit → value in SI base. */
  toBase(v: number): number {
    return v * this.factor + this.offset;
  }
  /** Value in SI base → value in this unit. */
  fromBase(b: number): number {
    return (b - this.offset) / this.factor;
  }

  get affine(): boolean {
    return this.offset !== 0;
  }

  private mulGuard(o: Unit): void {
    if (this.affine || o.affine) throw new Error("affine units don't compose");
  }

  times(o: Unit): Unit {
    this.mulGuard(o);
    return new Unit(
      this.factor * o.factor,
      this.dim.map((x, i) => x + o.dim[i]!),
    );
  }
  div(o: Unit): Unit {
    this.mulGuard(o);
    return new Unit(
      this.factor / o.factor,
      this.dim.map((x, i) => x - o.dim[i]!),
    );
  }
  pow(n: number): Unit {
    this.mulGuard(this);
    return new Unit(
      this.factor ** n,
      this.dim.map(x => x * n),
    );
  }
  /** Linear prefix multiple (km = m.scaled(1000)). */
  scaled(k: number, symbol = "", name = ""): Unit {
    return new Unit(this.factor * k, this.dim.slice(), 0, symbol, name);
  }
  labelled(symbol: string, name = symbol): Unit {
    return new Unit(this.factor, this.dim.slice(), this.offset, symbol, name);
  }

  sameDim(o: Unit): boolean {
    return this.dim.every((x, i) => x === o.dim[i]);
  }
}

/** Affine unit on the temperature dimension (factor·v + offset → kelvin). */
const affine = (factor: number, offset: number, symbol: string, name: string): Unit =>
  new Unit(factor, basis(4), offset, symbol, name);

// ─── Base units ──────────────────────────────────────────────────────
export const meter = new Unit(1, basis(0), 0, "m", "metre");
export const kilogram = new Unit(1, basis(1), 0, "kg", "kilogram");
export const second = new Unit(1, basis(2), 0, "s", "second");
export const ampere = new Unit(1, basis(3), 0, "A", "ampere");
export const kelvin = new Unit(1, basis(4), 0, "K", "kelvin");
export const byte = new Unit(1, basis(7), 0, "B", "byte");
export const radian = new Unit(1, basis(8), 0, "rad", "radian");

// ─── The zoo: everything else is composition ─────────────────────────
// length
export const km = meter.scaled(1000, "km", "kilometre");
export const cm = meter.scaled(0.01, "cm", "centimetre");
export const mm = meter.scaled(0.001, "mm", "millimetre");
export const inch = meter.scaled(0.0254, "in", "inch");
export const foot = meter.scaled(0.3048, "ft", "foot");
export const yard = meter.scaled(0.9144, "yd", "yard");
export const mile = meter.scaled(1609.344, "mi", "mile");
export const nmi = meter.scaled(1852, "nmi", "nautical mile");
// mass
export const gram = kilogram.scaled(0.001, "g", "gram");
export const tonne = kilogram.scaled(1000, "t", "tonne");
export const pound = kilogram.scaled(0.45359237, "lb", "pound");
export const ounce = kilogram.scaled(0.028349523125, "oz", "ounce");
// time
export const minute = second.scaled(60, "min", "minute");
export const hour = second.scaled(3600, "h", "hour");
export const day = second.scaled(86400, "d", "day");
// temperature (affine — leaves of the algebra)
export const celsius = affine(1, 273.15, "°C", "Celsius");
export const fahrenheit = affine(5 / 9, 273.15 - (32 * 5) / 9, "°F", "Fahrenheit");
// speed (compound)
export const mps = meter.div(second).labelled("m/s", "metre/second");
export const kmh = km.div(hour).labelled("km/h", "kilometre/hour");
export const mphSpeed = mile.div(hour).labelled("mph", "mile/hour");
export const knot = nmi.div(hour).labelled("kn", "knot");
// area & volume (powers — note factor is k², k³)
export const sqm = meter.pow(2).labelled("m²", "square metre");
export const hectare = sqm.scaled(10000, "ha", "hectare");
export const acre = sqm.scaled(4046.8564224, "ac", "acre");
export const m3 = meter.pow(3).labelled("m³", "cubic metre");
export const litre = m3.scaled(0.001, "L", "litre");
export const gallon = litre.scaled(3.785411784, "gal", "US gallon");
export const cup = litre.scaled(0.2365882365, "cup", "US cup");
// derived SI
export const newton = kilogram.times(meter).div(second.pow(2)).labelled("N", "newton");
export const joule = newton.times(meter).labelled("J", "joule");
export const watt = joule.div(second).labelled("W", "watt");
export const pascal = newton.div(meter.pow(2)).labelled("Pa", "pascal");
export const hertz = second.pow(-1).labelled("Hz", "hertz");
// data
export const bit = byte.scaled(0.125, "bit", "bit");
export const kB = byte.scaled(1e3, "kB", "kilobyte");
export const mB = byte.scaled(1e6, "MB", "megabyte");
export const gB = byte.scaled(1e9, "GB", "gigabyte");
export const kiB = byte.scaled(1024, "KiB", "kibibyte");
export const miB = byte.scaled(1024 ** 2, "MiB", "mebibyte");
// angle
export const degree = radian.scaled(Math.PI / 180, "°", "degree");
export const turn = radian.scaled(2 * Math.PI, "turn", "turn");
export const gradian = radian.scaled(Math.PI / 200, "grad", "gradian");

// ─── Converter categories (each shares one dimension) ────────────────
export interface Category {
  label: string;
  units: Unit[];
}
export const CATEGORIES: Category[] = [
  { label: "Length", units: [meter, km, cm, mm, inch, foot, yard, mile, nmi] },
  { label: "Mass", units: [kilogram, gram, tonne, pound, ounce] },
  { label: "Time", units: [second, minute, hour, day] },
  { label: "Temperature", units: [kelvin, celsius, fahrenheit] },
  { label: "Speed", units: [mps, kmh, mphSpeed, knot] },
  { label: "Area", units: [sqm, hectare, acre] },
  { label: "Volume", units: [litre, m3, gallon, cup] },
  { label: "Data", units: [bit, byte, kB, mB, gB, kiB, miB] },
  { label: "Angle", units: [radian, degree, turn, gradian] },
];

// ─── Dimension naming (for the algebra playground) ───────────────────
export const NAMED_DIMS: { unit: Unit; name: string }[] = [
  { unit: new Unit(1, zero()), name: "dimensionless" },
  { unit: meter, name: "length" },
  { unit: kilogram, name: "mass" },
  { unit: second, name: "time" },
  { unit: ampere, name: "current" },
  { unit: kelvin, name: "temperature" },
  { unit: sqm, name: "area" },
  { unit: m3, name: "volume" },
  { unit: mps, name: "velocity" },
  { unit: meter.div(second.pow(2)), name: "acceleration" },
  { unit: newton, name: "force" },
  { unit: joule, name: "energy" },
  { unit: watt, name: "power" },
  { unit: pascal, name: "pressure" },
  { unit: hertz, name: "frequency" },
  { unit: kilogram.div(m3), name: "density" },
];

/** Human name for a dimension, or `null` if unrecognised. */
export function dimName(u: Unit): string | null {
  return NAMED_DIMS.find(d => d.unit.sameDim(u))?.name ?? null;
}

/** Render a dimension vector as `kg·m·s⁻²` (superscript exponents). */
export function formatDim(dim: Dim): string {
  const sup = (n: number): string => {
    const map: Record<string, string> = {
      "-": "⁻",
      "0": "⁰",
      "1": "¹",
      "2": "²",
      "3": "³",
      "4": "⁴",
      "5": "⁵",
      "6": "⁶",
      "7": "⁷",
      "8": "⁸",
      "9": "⁹",
    };
    return String(n)
      .split("")
      .map(c => map[c] ?? c)
      .join("");
  };
  const parts = dim
    .map((e, i) => (e === 0 ? "" : e === 1 ? DIM_SYMBOLS[i]! : `${DIM_SYMBOLS[i]}${sup(e)}`))
    .filter(Boolean);
  return parts.length ? parts.join("·") : "1";
}

/** Named zoo units sharing `u`'s dimension (for "compatible units"). */
export function unitsLike(u: Unit): Unit[] {
  const all = CATEGORIES.flatMap(c => c.units);
  return all.filter(x => x.sameDim(u) && x.symbol);
}
