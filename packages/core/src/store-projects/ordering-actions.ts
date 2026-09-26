import { getTaskOrder } from '../store-helpers';
import { compareTasksByProjectOrder, sortTasksByBoardOrder } from '../task-utils';
import { mutateTasks } from '../store-tasks';
import type { OrderingActions, Project, ProjectActionContext, Section, Task, TaskStatus } from './shared';
import { mutateEntities } from './shared';

const ORDER_STEP = 1024;

type SparseOrderPlan =
    | { kind: 'single'; id: string; order: number }
    | { kind: 'rebalance'; orderById: Map<string, number> };

const finiteOrder = (value: number | null | undefined): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const sameOrder = (left: string[], right: string[]): boolean => (
    left.length === right.length && left.every((id, index) => id === right[index])
);

const uniqueValidIds = (orderedIds: string[], validIds: Set<string>): string[] => {
    const seen = new Set<string>();
    return orderedIds.filter((id) => {
        if (!validIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
};

const finalOrderedIds = (currentIds: string[], orderedIds: string[]): string[] => {
    const orderedSet = new Set(orderedIds);
    return [...orderedIds, ...currentIds.filter((id) => !orderedSet.has(id))];
};

const boardOrderedIds = (currentIds: string[], shownIds: string[], movedTaskId?: string): string[] => {
    const shown = new Set(shownIds);
    const currentShown = currentIds.filter((id) => shown.has(id));
    if (sameOrder(currentShown, shownIds)) return currentIds;
    const moved = movedTaskId && shown.has(movedTaskId) ? movedTaskId : findSingleMovedId(currentShown, shownIds);
    if (moved) {
        const remaining = currentIds.filter((id) => id !== moved);
        const shownWithoutMoved = shownIds.filter((id) => id !== moved);
        const at = shownIds.indexOf(moved);
        const next = shownWithoutMoved[at];
        const previous = shownWithoutMoved[at - 1];
        const insert = previous ? remaining.indexOf(previous) + 1 : next ? remaining.indexOf(next) : remaining.length;
        remaining.splice(insert, 0, moved);
        return remaining;
    }
    let index = 0;
    return currentIds.map((id) => shown.has(id) ? shownIds[index++] : id);
};

const findSingleMovedId = (currentIds: string[], nextIds: string[]): string | null => {
    if (currentIds.length !== nextIds.length || sameOrder(currentIds, nextIds)) return null;
    if (new Set(currentIds).size !== currentIds.length || new Set(nextIds).size !== nextIds.length) return null;

    const changedIds = new Set<string>();
    nextIds.forEach((id, index) => {
        if (currentIds[index] !== id) {
            changedIds.add(id);
            const currentId = currentIds[index];
            if (currentId) changedIds.add(currentId);
        }
    });

    for (const id of changedIds) {
        const fromIndex = currentIds.indexOf(id);
        const toIndex = nextIds.indexOf(id);
        if (fromIndex === -1 || toIndex === -1) continue;
        const candidate = currentIds.slice();
        candidate.splice(fromIndex, 1);
        candidate.splice(toIndex, 0, id);
        if (sameOrder(candidate, nextIds)) return id;
    }
    return null;
};

const sparseOrderForMove = (
    nextIds: string[],
    movedId: string,
    orderById: Map<string, number | undefined>,
): number | null => {
    const index = nextIds.indexOf(movedId);
    if (index === -1) return null;

    const previousId = nextIds[index - 1];
    const nextId = nextIds[index + 1];
    const previousOrder = previousId ? finiteOrder(orderById.get(previousId)) : undefined;
    const nextOrder = nextId ? finiteOrder(orderById.get(nextId)) : undefined;

    // Orders must stay integers: fractional midpoints don't survive integer-typed
    // storage layers (desktop SQLite bound orderNum as i64, CloudKit stores INT64),
    // where they degrade to NULL/truncation and the task jumps after a sync (#784).
    if (!previousId && !nextId) return finiteOrder(orderById.get(movedId)) ?? 0;
    if (!previousId) return nextOrder === undefined ? 0 : Math.floor(nextOrder) - ORDER_STEP;
    if (previousOrder === undefined) return null;
    if (!nextId) return Math.floor(previousOrder) + ORDER_STEP;
    if (nextOrder === undefined) return Math.floor(previousOrder) + ORDER_STEP;
    const midpoint = Math.floor((previousOrder + nextOrder) / 2);
    if (midpoint <= previousOrder || midpoint >= nextOrder) return null;
    return midpoint;
};

const createSparseOrderPlan = (
    currentIds: string[],
    nextIds: string[],
    orderById: Map<string, number | undefined>,
): SparseOrderPlan | null => {
    if (sameOrder(currentIds, nextIds)) return null;

    const movedId = findSingleMovedId(currentIds, nextIds);
    if (movedId) {
        const order = sparseOrderForMove(nextIds, movedId, orderById);
        if (order !== null && Number.isFinite(order)) {
            return { kind: 'single', id: movedId, order };
        }
    }

    const rebalanceOrderById = new Map<string, number>();
    nextIds.forEach((id, index) => {
        rebalanceOrderById.set(id, index * ORDER_STEP);
    });
    return { kind: 'rebalance', orderById: rebalanceOrderById };
};

const orderFromPlan = (plan: SparseOrderPlan, id: string): number | undefined => (
    plan.kind === 'single' ? (plan.id === id ? plan.order : undefined) : plan.orderById.get(id)
);

export const createOrderingActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): OrderingActions => ({
    reorderProjects: async (orderedIds: string[], areaId?: string) => {
        if (orderedIds.length === 0) return;
        const targetAreaId = areaId ?? undefined;
        let orderPlan: SparseOrderPlan | null = null;
        await mutateEntities({ set, debouncedSave }, {
            collection: 'projects',
            select: (state) => {
                const isInArea = (project: Project) => (
                    (project.areaId ?? undefined) === targetAreaId && !project.deletedAt
                );
                const areaProjects = state._allProjects.filter(isInArea);
                const currentIds = areaProjects
                    .sort((a, b) => (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0))
                    .map((project) => project.id);
                const validOrderedIds = uniqueValidIds(orderedIds, new Set(currentIds));
                if (validOrderedIds.length === 0) return [];
                const nextIds = finalOrderedIds(currentIds, validOrderedIds);
                const orderById = new Map(areaProjects.map((project) => [project.id, finiteOrder(project.order)]));
                orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
                if (!orderPlan) return [];
                return areaProjects.filter((project) => {
                    const nextOrder = orderFromPlan(orderPlan!, project.id);
                    return Number.isFinite(nextOrder) && project.order !== nextOrder;
                });
            },
            buildUpdates: (project) => {
                const nextOrder = orderFromPlan(orderPlan!, project.id);
                return Number.isFinite(nextOrder) ? { order: nextOrder as number } : null;
            },
        });
    },

    reorderSections: async (projectId: string, orderedIds: string[]) => {
        if (!projectId || orderedIds.length === 0) return;
        let orderPlan: SparseOrderPlan | null = null;
        await mutateEntities({ set, debouncedSave }, {
            collection: 'sections',
            select: (state) => {
                if (!state._allProjects.some((project) => project.id === projectId && !project.deletedAt)) return [];
                const isInProject = (section: Section) => section.projectId === projectId && !section.deletedAt;
                const projectSections = state._allSections.filter(isInProject);
                const projectSectionIds = new Set(projectSections.map((section) => section.id));
                const validOrderedIds = orderedIds.filter((id) => projectSectionIds.has(id));
                if (validOrderedIds.length === 0) return [];
                const currentIds = projectSections
                    .sort((a, b) => {
                        const aOrder = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
                        const bOrder = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
                        if (aOrder !== bOrder) return aOrder - bOrder;
                        return a.title.localeCompare(b.title);
                    })
                    .map((section) => section.id);
                const nextIds = finalOrderedIds(currentIds, uniqueValidIds(validOrderedIds, projectSectionIds));
                const orderById = new Map(projectSections.map((section) => [section.id, finiteOrder(section.order)]));
                orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
                if (!orderPlan) return [];
                return projectSections.filter((section) => {
                    const nextOrder = orderFromPlan(orderPlan!, section.id);
                    return Number.isFinite(nextOrder) && section.order !== nextOrder;
                });
            },
            buildUpdates: (section) => {
                const nextOrder = orderFromPlan(orderPlan!, section.id);
                return Number.isFinite(nextOrder) ? { order: nextOrder as number } : null;
            },
        });
    },

    reorderProjectTasks: async (projectId: string, orderedIds: string[], sectionId?: string | null) => {
        if (!projectId || orderedIds.length === 0) return;
        let orderPlan: SparseOrderPlan | null = null;
        await mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const hasSectionFilter = sectionId !== undefined;
                const isInProject = (task: Task) => {
                    if (task.projectId !== projectId || task.deletedAt) return false;
                    if (!hasSectionFilter) return true;
                    return sectionId ? task.sectionId === sectionId : !task.sectionId;
                };
                const projectTasks = state._allTasks.filter(isInProject);
                const projectTaskIds = new Set(projectTasks.map((task) => task.id));
                const validOrderedIds = uniqueValidIds(orderedIds, projectTaskIds);
                if (validOrderedIds.length === 0) return [];
                // Must sort EXACTLY like the display comparator (including its
                // id tie-break, #784) — the plan's baseline and what the user
                // sees must be the same arrangement or a drop is computed
                // against rows the view never showed in that order.
                const currentIds = projectTasks
                    .sort(compareTasksByProjectOrder)
                    .map((task) => task.id);
                const nextIds = finalOrderedIds(currentIds, validOrderedIds);
                const orderById = new Map(projectTasks.map((task) => [task.id, getTaskOrder(task)]));
                orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
                if (!orderPlan) return [];
                return projectTasks.filter((task) => {
                    const nextOrder = orderFromPlan(orderPlan!, task.id);
                    return Number.isFinite(nextOrder)
                        && !(getTaskOrder(task) === nextOrder && task.order === nextOrder && task.orderNum === nextOrder);
                });
            },
            buildUpdates: (task) => {
                const nextOrder = orderFromPlan(orderPlan!, task.id);
                return {
                    order: nextOrder as number,
                    orderNum: nextOrder as number,
                };
            },
        });
    },

    reorderBoardTasks: async (status: TaskStatus, orderedIds: string[], movedTaskId?: string) => {
        if (!status || orderedIds.length === 0) return;
        let orderPlan: SparseOrderPlan | null = null;
        await mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const columnTasks = state._allTasks.filter((task) => task.status === status && !task.deletedAt);
                const columnTaskIds = new Set(columnTasks.map((task) => task.id));
                const validOrderedIds = uniqueValidIds(orderedIds, columnTaskIds);
                if (validOrderedIds.length === 0) return [];
                const currentIds = sortTasksByBoardOrder(columnTasks).map((task) => task.id);
                const nextIds = boardOrderedIds(currentIds, validOrderedIds, movedTaskId);
                const orderById = new Map(columnTasks.map((task) => [task.id, finiteOrder(task.boardOrder)]));
                orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
                if (!orderPlan) return [];
                return columnTasks.filter((task) => {
                    const nextOrder = orderFromPlan(orderPlan!, task.id);
                    return Number.isFinite(nextOrder) && task.boardOrder !== nextOrder;
                });
            },
            buildUpdates: (task) => {
                const nextOrder = orderFromPlan(orderPlan!, task.id);
                return { boardOrder: nextOrder as number };
            },
        });
    },
});
