/** One interactive element as interactiveSnapshot reports it. Absent fields mean "not set". */
export interface SnapshotElement {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  /** Explicit role attribute, or the implicit role of the tag/input type. */
  role?: string;
  text?: string;
  href?: string;
  placeholder?: string;
  value?: string;
  /** `aria-label`, or the resolved text of `aria-labelledby`. */
  ariaLabel?: string;
  /** Checkbox/radio state, or `aria-checked` on an element that declares the attribute. */
  checked?: boolean;
  /** `<option>` selection, or `aria-selected`. */
  selected?: boolean;
  /** `aria-expanded`, when the element declares it. */
  expanded?: boolean;
  /** Native `disabled`, or `aria-disabled="true"`. */
  disabled?: boolean;
  inViewport?: boolean;
}

export interface InteractiveSnapshot {
  url: string;
  readyState: string;
  /** Every interactive element in view-independent terms; `elements` holds at most the first 150. */
  count: number;
  /** True when `count` is larger than `elements` because of the 150-element cap. */
  truncated?: boolean;
  elements: SnapshotElement[];
}
