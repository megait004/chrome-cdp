/** One interactive element as interactiveSnapshot reports it. Absent fields mean "not set". */
export interface SnapshotElement {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  text?: string;
  href?: string;
  placeholder?: string;
  value?: string;
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
