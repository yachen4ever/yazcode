import { create } from "zustand";
import type { ProjectRecord } from "@zcode/services";
import type { IProjectService } from "@zcode/services";
import { logger } from "@/logger.js";

/**
 * 多目录项目 P3a 状态底座（docs/specs/multi-root-projects.md「P3a 状态底座」）。
 *
 * 状态所有者：项目事实的唯一持久所有者是 ProjectRepository（tasks-index.sqlite），
 * 经 IProjectService 读写；本 store 只是它的派生读模型——缓存 listProjects 快照、
 * 以服务返回值就地更新，不落盘、不生成 projectId、不改写 roots，也没有远端广播面
 * （项目当前没有跨端同步语义）。写路径唯一入口是显式 action 中已成功的服务调用。
 */

export type ProjectStoreStatus = "idle" | "loading" | "ready" | "error";

interface ProjectStoreState {
  projects: ProjectRecord[];
  status: ProjectStoreStatus;
  error: string | null;
  /** 幂等单飞拉取；已在 ready 态时默认跳过（force 走 refresh）。 */
  load: (service: IProjectService, options?: { force?: boolean }) => Promise<void>;
  /** 强制重拉；并发去重，最后一次结果落库。 */
  refresh: (service: IProjectService) => Promise<void>;
  /** 编辑器保存成功后以服务返回记录就地更新（ projectId 相同即替换）。 */
  upsert: (record: ProjectRecord) => void;
  /** 删除成功后就地移除。 */
  remove: (projectId: string) => void;
}

let inFlightLoad: Promise<void> | null = null;

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  projects: [],
  status: "idle",
  error: null,
  load: async (service, options) => {
    if (!options?.force && get().status === "ready" && inFlightLoad === null) {
      return;
    }
    await get().refresh(service);
  },
  refresh: async (service) => {
    if (inFlightLoad) {
      return inFlightLoad;
    }
    const request = (async () => {
      set({ status: get().status === "idle" ? "loading" : get().status, error: null });
      try {
        const projects = await service.listProjects();
        set({ projects, status: "ready", error: null });
      } catch (error) {
        // 读模型失败不阻塞 UI：保留旧快照，错误态由调用方决定是否重试。
        logger.warn("[project-store] listProjects 失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        set({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      if (inFlightLoad === request) {
        inFlightLoad = null;
      }
    });
    inFlightLoad = request;
    return request;
  },
  upsert: (record) => {
    set((state) => {
      const index = state.projects.findIndex((item) => item.projectId === record.projectId);
      if (index < 0) {
        return { projects: [...state.projects, record] };
      }
      const next = [...state.projects];
      next[index] = record;
      return { projects: next };
    });
  },
  remove: (projectId) => {
    set((state) => ({
      projects: state.projects.filter((item) => item.projectId !== projectId),
    }));
  },
}));
