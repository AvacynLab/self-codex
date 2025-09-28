import { GraphModel } from "../model.js";

export type StronglyConnectedComponent = string[];

export function tarjanScc(graph: GraphModel): StronglyConnectedComponent[] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const components: StronglyConnectedComponent[] = [];

  const visit = (nodeId: string): void => {
    indices.set(nodeId, index);
    lowlinks.set(nodeId, index);
    index++;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const edge of graph.getOutgoing(nodeId)) {
      const neighbor = edge.to;
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId)!, lowlinks.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowlinks.set(nodeId, Math.min(lowlinks.get(nodeId)!, indices.get(neighbor)!));
      }
    }

    if (lowlinks.get(nodeId) === indices.get(nodeId)) {
      const component: string[] = [];
      while (true) {
        const candidate = stack.pop();
        if (!candidate) {
          break;
        }
        onStack.delete(candidate);
        component.push(candidate);
        if (candidate === nodeId) {
          break;
        }
      }
      components.push(component);
    }
  };

  for (const node of graph.listNodes()) {
    if (!indices.has(node.id)) {
      visit(node.id);
    }
  }

  return components;
}
