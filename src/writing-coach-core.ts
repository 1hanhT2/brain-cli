export const chooseWritingCoachInterval = (
  minimum: number,
  maximum: number,
  random: () => number = Math.random
): number => Math.min(
  maximum,
  minimum + Math.floor(random() * (maximum - minimum + 1))
);
