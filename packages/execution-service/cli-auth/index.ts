import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sameAeIdentity, safeURL, type Scope, type AeCliAuthState } from '../../contracts';
import { assertAllowedOrigin, executionContext } from '../context';
import { credential, getDataDir, readConfig, writeConfig } from '../storage';
import { aeCredentialRef } from '../cli-runner';

const pendingRef = 'ae-device-login';
type Record = { id: string; scope: Scope; state: AeCliAuthState; deviceCode?: string; accessToken?: string; nextPollAt: number; interval: number; accountId?: string };
class AuthFailure extends Error { constructor(readonly status: AeCliAuthState['status'], message: string) { super(message); } }

// Uses the same fixed device, token-generation and validation endpoints as AE CLI.
// OAuth/device tokens never leave this service. Only the final CLI credential is
// persisted for the existing isolated CLI runner, encrypted by service user.
export class CliAuthorization {
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  private async scope() { const c = await readConfig(); if (!c.binding) throw new Error('请先从已登录的 AE 页面识别工作区'); safeURL(c.binding.origin); assertAllowedOrigin(c.binding.origin); if (!executionContext()) throw new Error('设备码授权需要线上用户工作区'); return c.binding; }
  private async load(): Promise<Record | undefined> { try { return JSON.parse(await credential(pendingRef)); } catch (e) { if (e instanceof Error && e.message.includes('尚未保存')) return; throw new Error('无法读取云端授权会话，请重新授权'); } }
  private async save(record: Record) { await credential(pendingRef, JSON.stringify(record)); }
  private public(record: Record): AeCliAuthState { return { ...record.state }; }
  private async finish(record: Record, status: AeCliAuthState['status'], message: string, extra: Partial<AeCliAuthState> = {}) {
    delete record.deviceCode; delete record.accessToken;
    record.state = { status, message, origin: record.scope.origin, ...extra }; await this.save(record); return this.public(record);
  }
  private async request(scope: Scope, path: string, init: RequestInit = {}) {
    assertAllowedOrigin(scope.origin);
    let response: Response;
    try { response = await fetch(new URL(path, scope.origin), { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) }); }
    catch (error) {
      const code = (error as any)?.cause?.code;
      if (['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code)) throw new AuthFailure('error', '云端连接 AE 环境超时（HTTPS 443 端口），请确认 AE 环境允许云端服务访问');
      if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) throw new AuthFailure('error', '云端无法解析 AE 环境域名，请检查环境地址与 DNS 配置');
      throw new AuthFailure('error', '无法连接 AE 授权服务，请稍后重试');
    }
    let body: any;
    try { body = await response.json(); } catch { throw new AuthFailure('error', response.status === 404 ? '此 AE 环境暂不支持设备码授权，请联系管理员检查服务版本' : 'AE 授权服务未返回有效数据，请稍后重试'); }
    return { response, body };
  }
  private async validate(scope: Scope, token: string) {
    const { response, body } = await this.request(scope, '/v1/ta/cli/token/validate', { headers: { Accept: 'application/json', 'cli-token': token } });
    if (response.status === 401 || body.code === 'CLI_TOKEN_EXPIRED' || body.code === 'CLI_TOKEN_INVALID') throw new AuthFailure('not-authorized', 'AE CLI 授权已失效，请重新授权');
    if (response.status === 403 || body.code === 'CLI_ACCESS_DISABLED') throw new AuthFailure('denied', '当前 AE 账号没有 CLI 访问权限，请联系 AE 管理员');
    if (!response.ok || body.return_code !== 0) throw new AuthFailure('unverified', '暂时无法验证 AE CLI 授权，请稍后检查');
    return body.data ?? {};
  }
  async view(): Promise<AeCliAuthState> {
    const c = await readConfig(), scope = c.binding;
    if (!scope) return { status: 'not-authorized', message: '请先识别已登录的 AE 工作区' };
    const record = await this.load();
    if (record && sameAeIdentity(scope, record.scope)) {
      if (record.state.status === 'pending' && (record.state.expiresAt ?? 0) <= Date.now()) return { status: 'expired', origin: scope.origin, message: '授权链接已过期，请重新发起授权' };
      if (record.state.status !== 'authenticated' || sameAeIdentity(scope, c.aeAuthScope)) return this.public(record);
    }
    if (c.aeAuthScope && !sameAeIdentity(scope, c.aeAuthScope)) return { status: 'account-mismatch', origin: scope.origin, message: 'AE 账号或租户已切换，请为当前账号重新授权' };
    const exists = await access(join(getDataDir(), 'credentials', `${aeCredentialRef(scope.origin)}.json`)).then(() => true, () => false);
    return { status: exists ? 'unverified' : 'not-authorized', origin: scope.origin, message: exists ? '已有工具凭据，请检查是否仍然有效' : '尚未授权 AE CLI，可在这里或对话中发起浏览器授权' };
  }
  start() { return this.serial(async () => {
    const scope = await this.scope(), existing = await this.load();
    if (existing && sameAeIdentity(scope, existing.scope) && existing.state.status === 'pending' && (existing.state.expiresAt ?? 0) > Date.now()) return this.public(existing);
    const status = await this.statusImpl(); if (status.status === 'authenticated') return status;
    const record: Record = { id: randomUUID(), scope, state: { status: 'pending', origin: scope.origin, message: '请在 AE 网页确认授权，完成后会自动检查' }, nextPollAt: 0, interval: 5000 };
    try {
      const { response, body } = await this.request(scope, '/agent/api/auth/device/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (response.status === 404) throw new AuthFailure('error', '此 AE 环境暂不支持设备码授权，请联系管理员检查服务版本');
      if (response.status === 403) throw new AuthFailure('denied', '当前 AE 账号没有 CLI 访问权限，请联系 AE 管理员');
      if (!response.ok || typeof body.device_code !== 'string' || !body.device_code || body.device_code.length > 4096 || !/^[a-zA-Z0-9-]{4,64}$/.test(body.user_code) || !Number.isFinite(Number(body.interval ?? 5)) || !Number.isFinite(Number(body.expires_in ?? 300))) throw new AuthFailure('error', 'AE 未返回有效的设备授权信息，请重试');
      record.deviceCode = body.device_code; record.interval = Math.min(30000, Math.max(1000, Number(body.interval || 5) * 1000));
      record.state = { ...record.state, verificationURL: `${scope.origin}/agent/device-activate?user_code=${encodeURIComponent(body.user_code)}`, userCode: body.user_code, expiresAt: Date.now() + Math.min(1800, Math.max(30, Number(body.expires_in || 300))) * 1000, pollIntervalMs: record.interval };
      await this.save(record); return this.public(record);
    } catch (error) { return this.finish(record, error instanceof AuthFailure ? error.status : 'error', error instanceof AuthFailure ? error.message : '发起 AE 授权失败，请重试'); }
  }); }
  check() { return this.serial(async () => {
    const scope = await this.scope(), record = await this.load();
    if (!record || record.state.status === 'authenticated') return this.statusImpl();
    if (!sameAeIdentity(scope, record.scope)) return this.finish(record, 'account-mismatch', 'AE 账号或租户已切换，请重新发起授权');
    if (record.state.status !== 'pending') return this.public(record);
    if ((record.state.expiresAt ?? 0) <= Date.now()) return this.finish(record, 'expired', '授权链接已过期，请重新发起授权');
    if (record.nextPollAt > Date.now()) return this.public(record);
    try {
      if (!record.accessToken) {
        const { response, body } = await this.request(scope, '/agent/api/auth/device/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: record.deviceCode }) });
        if (body.error === 'authorization_pending' || body.error === 'slow_down') {
          if (body.error === 'slow_down') record.interval = Math.min(30000, record.interval + 5000);
          record.nextPollAt = Date.now() + record.interval; record.state.pollIntervalMs = record.interval; await this.save(record); return this.public(record);
        }
        if (body.error === 'expired_token') return this.finish(record, 'expired', '授权链接已过期，请重新发起授权');
        if (response.status === 403 || body.error === 'access_denied') return this.finish(record, 'denied', '授权已被拒绝或当前 AE 账号未启用 CLI 访问');
        if (!response.ok || typeof body.access_token !== 'string' || body.access_token.length > 16384) throw new AuthFailure('error', '无法完成设备授权，请重新发起');
        record.accessToken = body.access_token; await this.save(record);
      }
      // Verify the browser-approved identity against the live AE user/project API,
      // not service username or an unrelated external-account identifier.
      const { response: userResponse, body: userBody } = await this.request(scope, '/v1/oauth/check', { method: 'POST', headers: { Authorization: `bearer ${record.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body: '' });
      const user = userBody.data, current = await readConfig();
      const project = user?.projectInfoList?.find((p: any) => String(p.projectId) === current.binding?.projectId);
      if (!userResponse.ok || userBody.return_code !== 0 || !current.binding || !sameAeIdentity(scope, current.binding) || String(user?.userId) !== scope.actorId || !project || (scope.tenantId !== undefined && String(project.companyId) !== scope.tenantId)) return this.finish(record, 'account-mismatch', '授权账号或项目与当前 AE 工作区不一致，请使用当前识别到的 AE 账号授权');
      const { response, body } = await this.request(scope, '/v1/ta/cli/token/generate', { headers: { Authorization: `bearer ${record.accessToken}` } });
      const token = body.data?.userSecret ?? body.data?.user_secret;
      if (response.status === 403 || body.code === 'CLI_ACCESS_DISABLED') return this.finish(record, 'denied', '当前 AE 账号没有 CLI 访问权限，请联系 AE 管理员');
      if (!response.ok || body.return_code !== 0 || typeof token !== 'string' || !/^cli_\S{1,16380}$/.test(token)) throw new AuthFailure('error', 'AE 未签发有效的 CLI 授权，请重新发起');
      const metadata = await this.validate(scope, token);
      const latest = await readConfig(); if (!latest.binding || !sameAeIdentity(scope, latest.binding)) return this.finish(record, 'account-mismatch', 'AE 工作区已切换，请重新授权');
      await credential(aeCredentialRef(scope.origin), token); await writeConfig({ ...latest, aeAuthScope: latest.binding });
      record.scope = latest.binding; record.accountId = metadata.openId ?? metadata.open_id;
      return this.finish(record, 'authenticated', 'AE CLI 授权已验证，可以使用当前工作区的业务工具', { accountName: String(user.loginName ?? '').slice(0, 256), checkedAt: Date.now() });
    } catch (error) { return this.finish(record, error instanceof AuthFailure ? error.status : 'error', error instanceof AuthFailure ? error.message : 'AE 授权验证失败，请重试'); }
  }); }
  cancel() { return this.serial(async () => { const scope = await this.scope(), record = await this.load(); if (!record || !sameAeIdentity(scope, record.scope)) return this.view(); if (record.state.status !== 'pending') return this.public(record); return this.finish(record, 'cancelled', '本次授权已取消，可重新发起'); }); }
  status() { return this.serial(() => this.statusImpl()); }
  private async statusImpl(): Promise<AeCliAuthState> {
    const scope = await this.scope(), config = await readConfig();
    const pending = await this.load();
    if (pending && sameAeIdentity(scope, pending.scope) && pending.state.status === 'pending') return this.view();
    if (!sameAeIdentity(scope, config.aeAuthScope)) return this.view();
    let token: string;
    try { token = await credential(aeCredentialRef(scope.origin)); } catch { return { status: 'not-authorized', origin: scope.origin, message: '尚未授权 AE CLI，请发起浏览器授权' }; }
    const record = await this.load() ?? { id: randomUUID(), scope, state: { status: 'unverified' as const, origin: scope.origin, message: '' }, nextPollAt: 0, interval: 5000 };
    try {
      const data = await this.validate(scope, token);
      if (record.accountId && record.accountId !== (data.openId ?? data.open_id)) return this.finish(record, 'account-mismatch', 'CLI 授权账号已变化，请重新授权');
      return this.finish(record, 'authenticated', 'AE CLI 授权已验证', { accountName: String(data.loginName ?? data.login_name ?? record.state.accountName ?? '').slice(0, 256), checkedAt: Date.now() });
    } catch (error) { return this.finish(record, error instanceof AuthFailure ? error.status : 'error', error instanceof AuthFailure ? error.message : '暂时无法检查 AE CLI 授权'); }
  }
}
