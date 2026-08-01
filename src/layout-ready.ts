export interface LayoutReadySource {
  onLayoutReady(callback: () => void): void;
}

export const runAfterLayoutReady = (source: LayoutReadySource, callback: () => void): void => {
  source.onLayoutReady(callback);
};
