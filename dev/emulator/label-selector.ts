// Hetzner label selectors, as the panel sends them.

export type Labels = Record<string, string>;

// Supports the selector forms the panel uses (`k=v`, comma separated) plus
// `k!=v` and bare `k`. Values are decoded since the panel pre-encodes them.
export function matchesLabelSelector(labels: Labels, selector: string | null): boolean {
  if (!selector) return true;
  return selector
    .split(",")
    .filter(Boolean)
    .every((term) => {
      const neq = term.indexOf("!=");
      if (neq > 0) return labels[term.slice(0, neq)] !== decode(term.slice(neq + 2));
      const eq = term.indexOf("=");
      if (eq > 0) return labels[term.slice(0, eq)] === decode(term.slice(eq + 1));
      return term in labels;
    });
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
