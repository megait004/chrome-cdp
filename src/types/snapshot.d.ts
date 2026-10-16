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
  count: number;
  elements: SnapshotElement[];
}
