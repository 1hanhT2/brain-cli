export interface ExpGoalLaneDefinition {
  name: string;
  target: number;
  tags: string[];
  projects: string[];
}

export const validateExpGoalLanes = (
  input: ExpGoalLaneDefinition[],
  overallTarget: number
): ExpGoalLaneDefinition[] => {
  const lanes = input.map((lane) => ({
    name: lane.name.trim(),
    target: lane.target,
    tags: lane.tags.map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean),
    projects: lane.projects.map((project) => project.trim()).filter(Boolean)
  }));
  if (lanes.some((lane) => !lane.name || !Number.isInteger(lane.target) || lane.target < 25)) {
    throw new Error("Each EXP goal lane needs a name and a whole-number target of at least 25.");
  }
  if (new Set(lanes.map((lane) => lane.name.toLocaleLowerCase())).size !== lanes.length) {
    throw new Error("EXP goal lane names must be unique.");
  }
  if (lanes.some((lane) => lane.tags.length === 0 && lane.projects.length === 0)) {
    throw new Error("Each EXP goal lane needs at least one tag or project filter.");
  }
  if (lanes.reduce((sum, lane) => sum + lane.target, 0) > overallTarget) {
    throw new Error("EXP goal lane targets cannot exceed the overall target.");
  }
  return lanes;
};
