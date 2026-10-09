import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type IMemoryService,
  type OpenVikingVerifyResult,
  type ProjectMemoryWorkspaceSummary,
} from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_SWITCH,
  type MemoryProvider,
  type OpenVikingConnection,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type MemoryCatalogService = Pick<IMemoryService, "listProjectMemories">;

function normalizeWorkspaceDisplayName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function buildWorkspaceDisplayNameMap(names: readonly string[]): ReadonlyMap<string, string> {
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of names) {
    const displayName = candidate.trim();
    const slug = normalizeWorkspaceDisplayName(displayName);
    if (!displayName || !slug || ambiguous.has(slug)) continue;
    const existing = matches.get(slug);
    if (existing && existing !== displayName) {
      matches.delete(slug);
      ambiguous.add(slug);
      continue;
    }
    matches.set(slug, displayName);
  }
  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemorySettingsSection({
  memoryProvider,
  openvikingConnection,
  memoryService,
  onMemoryProviderChange,
  onVerifyConnection,
  onActivate,
  onUninstall,
  projectMemoryViewerAvailable,
  workspaceDisplayNames = [],
}: {
  memoryProvider: MemoryProvider;
  openvikingConnection?: OpenVikingConnection;
  memoryService: MemoryCatalogService;
  onMemoryProviderChange: (provider: MemoryProvider) => Promise<void>;
  onVerifyConnection: (params: { url: string; userKey: string }) => Promise<OpenVikingVerifyResult>;
  onActivate: (params: { url: string; userKey: string }) => Promise<void>;
  onUninstall: () => Promise<void>;
  projectMemoryViewerAvailable: boolean;
  workspaceDisplayNames?: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const catalogRequestIdRef = useRef(0);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectMemoryWorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const refreshCatalog = useCallback(async (): Promise<ProjectMemoryWorkspaceSummary[] | null> => {
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const result = await memoryService.listProjectMemories();
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces(result);
      setCatalogState("ready");
      return result;
    } catch (error) {
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
      return null;
    }
  }, [memoryService]);

  useEffect(() => {
    if (memoryProvider === "local" && projectMemoryViewerAvailable) {
      void refreshCatalog();
      return;
    }

    catalogRequestIdRef.current += 1;
    setCatalogState("idle");
    setCatalogError(null);
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
  }, [memoryProvider, projectMemoryViewerAvailable, refreshCatalog]);

  const displayWorkspaces = useMemo(() => {
    const displayNameBySlug = buildWorkspaceDisplayNameMap(workspaceDisplayNames);
    const orderBySlug = new Map<string, number>();
    for (const [index, name] of workspaceDisplayNames.entries()) {
      const slug = normalizeWorkspaceDisplayName(name);
      if (!orderBySlug.has(slug)) orderBySlug.set(slug, index);
    }
    return workspaces
      .map((workspace, catalogIndex) => {
        const slug = normalizeWorkspaceDisplayName(workspace.label);
        return {
          catalogIndex,
          order: orderBySlug.get(slug) ?? Number.POSITIVE_INFINITY,
          workspace: {
            ...workspace,
            label: displayNameBySlug.get(slug) ?? workspace.label,
          },
        };
      })
      .sort((left, right) => left.order - right.order || left.catalogIndex - right.catalogIndex)
      .map(({ workspace }) => workspace);
  }, [workspaceDisplayNames, workspaces]);
  const selectedWorkspace = useMemo(
    () => displayWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [displayWorkspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    const firstWorkspace = displayWorkspaces[0];
    if (!firstWorkspace) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !displayWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(firstWorkspace.id);
    }
  }, [displayWorkspaces, selectedWorkspaceId]);

  const handleRefresh = useCallback(async () => {
    await refreshCatalog();
  }, [refreshCatalog]);

  // OpenViking 表单：地址与 user key 由用户现场填写，校验通过才允许启用。
  // 记忆提供方是三态无兜底的，错误的连接配置必须在保存前拦住，不能留到开会话才炸。
  const [ovUrl, setOvUrl] = useState(openvikingConnection?.url ?? "");
  const [ovUserKey, setOvUserKey] = useState(openvikingConnection?.userKey ?? "");
  const [ovChecking, setOvChecking] = useState(false);
  const [ovVerified, setOvVerified] = useState(false);
  const [ovError, setOvError] = useState<string | null>(null);
  const [ovVersion, setOvVersion] = useState<string | null>(null);

  // 已保存的连接发生变化时（例如从设置文件载入）重新同步表单初值。
  useEffect(() => {
    setOvUrl(openvikingConnection?.url ?? "");
    setOvUserKey(openvikingConnection?.userKey ?? "");
  }, [openvikingConnection?.url, openvikingConnection?.userKey]);

  const resetCheck = useCallback(() => {
    setOvVerified(false);
    setOvVersion(null);
    setOvError(null);
  }, []);

  const handleVerify = useCallback(async () => {
    resetCheck();
    setOvChecking(true);
    try {
      const result = await onVerifyConnection({ url: ovUrl.trim(), userKey: ovUserKey.trim() });
      if (result.ok) {
        setOvVerified(true);
        setOvVersion(result.version ?? null);
      } else {
        setOvError(result.message ?? "连接校验未通过。");
      }
    } catch (error) {
      setOvError(getErrorMessage(error));
    } finally {
      setOvChecking(false);
    }
  }, [onVerifyConnection, ovUrl, ovUserKey, resetCheck]);

  const handleActivate = useCallback(async () => {
    setOvError(null);
    setOvChecking(true);
    try {
      await onActivate({ url: ovUrl.trim(), userKey: ovUserKey.trim() });
      setOvVerified(true);
    } catch (error) {
      setOvError(getErrorMessage(error));
    } finally {
      setOvChecking(false);
    }
  }, [onActivate, ovUrl, ovUserKey]);

  const handleUninstall = useCallback(async () => {
    setOvError(null);
    setOvChecking(true);
    try {
      await onUninstall();
      setOvVerified(false);
      setOvVersion(null);
    } catch (error) {
      setOvError(getErrorMessage(error));
    } finally {
      setOvChecking(false);
    }
  }, [onUninstall]);

  const handleProviderChange = useCallback(
    (next: MemoryProvider) => {
      // 切到 openviking 前必须已有校验通过的连接，避免保存一个装不上的档位。
      if (next === "openviking" && !ovVerified) {
        void handleVerify().then(() => undefined);
        return;
      }
      void onMemoryProviderChange(next);
    },
    [handleVerify, onMemoryProviderChange, ovVerified],
  );

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.memory.provider",
          })}
          description={intl.formatMessage({
            id: "settings.memory.providerDescription",
          })}
          control={
            <Select value={memoryProvider} onValueChange={(value) => {
                handleProviderChange(value as MemoryProvider);
              }}>
              <SelectTrigger
                aria-label={intl.formatMessage({ id: "settings.memory.provider" })}
                data-testid={TID_SETTINGS_MEMORY_SWITCH}
                className="w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disable">
                  {intl.formatMessage({ id: "settings.memory.provider.disable" })}
                </SelectItem>
                <SelectItem value="local">
                  {intl.formatMessage({ id: "settings.memory.provider.local" })}
                </SelectItem>
                <SelectItem value="openviking">
                  {intl.formatMessage({ id: "settings.memory.provider.openviking" })}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>

      {memoryProvider === "openviking" ? (
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.memory.ov.url" })}
            description={intl.formatMessage({ id: "settings.memory.ov.urlDescription" })}
            control={
              <Input
                aria-label={intl.formatMessage({ id: "settings.memory.ov.url" })}
                value={ovUrl}
                placeholder="http://127.0.0.1:1933"
                className="w-72"
                onChange={(event) => {
                  setOvUrl(event.target.value);
                  resetCheck();
                }}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.memory.ov.userKey" })}
            description={intl.formatMessage({ id: "settings.memory.ov.userKeyDescription" })}
            control={
              <Input
                aria-label={intl.formatMessage({ id: "settings.memory.ov.userKey" })}
                type="password"
                value={ovUserKey}
                placeholder="user key"
                className="w-72"
                onChange={(event) => {
                  setOvUserKey(event.target.value);
                  resetCheck();
                }}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.memory.ov.actions",
            })}
            description={
              ovError
                ? ovError
                : ovVerified
                  ? intl.formatMessage(
                      { id: "settings.memory.ov.verified" },
                      { version: ovVersion ?? "-" },
                    )
                  : intl.formatMessage({ id: "settings.memory.ov.notVerified" })
            }
            control={
              <div className="flex items-center gap-2">
                <Button variant="outline" disabled={ovChecking} onClick={() => void handleVerify()}>
                  {intl.formatMessage({ id: "settings.memory.ov.test" })}
                </Button>
                <Button
                  disabled={ovChecking || !ovVerified}
                  onClick={() => void handleActivate()}
                >
                  {intl.formatMessage({ id: "settings.memory.ov.activate" })}
                </Button>
                <Button
                  variant="ghost"
                  disabled={ovChecking}
                  onClick={() => void handleUninstall()}
                >
                  {intl.formatMessage({ id: "settings.memory.ov.uninstall" })}
                </Button>
              </div>
            }
          />
        </SettingsGroupCard>
      ) : null}

      {!projectMemoryViewerAvailable ? (
        <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.viewer.localOnly" })}
        </div>
      ) : memoryProvider !== "local" ? null : (
        <MemorySettingsViewer
          catalogError={catalogError}
          catalogState={catalogState}
          selectedWorkspace={selectedWorkspace}
          workspaces={displayWorkspaces}
          onRefresh={handleRefresh}
          onScopeKeyChange={(workspaceId) => setSelectedWorkspaceId(workspaceId)}
        />
      )}
    </div>
  );
}
