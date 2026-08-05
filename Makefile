SIYUAN_CONTAINER ?= siyuan-linkmark-siyuan-dev
SIYUAN_IMAGE ?= b3log/siyuan:latest
SIYUAN_PORT ?= 6806
# 必须保持为空：v3.7.3 的 InitPublishJWT 会覆盖 jwtKey 导致插件 JWT 签名无效，
# 设置 accessAuthCode 后 CheckAuth 的 localhost 豁免失效，插件 forwardProxy 会全部
# 401（见 src/cache-authority.ts 的 base64url 注释）。去掉后开发环境走 localhost 豁免。
# 同时配合 SIYUAN_ACCESS_AUTH_CODE_BYPASS=true：Docker 端口映射下浏览器请求的
# RemoteAddr 是 docker0 网关（非 127.0.0.1），无锁屏密码时会被 CheckAuth 拒绝；
# 该环境变量跳过空锁屏密码检查（官方支持，https://github.com/siyuan-note/siyuan/issues/9709）。
SIYUAN_ACCESS_AUTH_CODE ?= 
SIYUAN_ACCESS_AUTH_CODE_BYPASS ?= true
SIYUAN_WORKSPACE ?= $(CURDIR)/dev/siyuan-workspace
DIST_DIR := $(CURDIR)/dist
DEV_TMUX_SESSION ?= siyuan-linkmark-dev

.PHONY: dev dev-build dev-container dev-stop

dev: dev-container
	@if ! tmux has-session -t "$(DEV_TMUX_SESSION)" 2>/dev/null; then \
		tmux new-session -d -s "$(DEV_TMUX_SESSION)" -n dev; \
	fi
	@tmux respawn-pane -k -t "$(DEV_TMUX_SESSION):dev" \
		"cd '$(CURDIR)' && npm run dev"
	@echo "dev server started in tmux session '$(DEV_TMUX_SESSION)'"

dev-build:
	npm run build

dev-container: dev-build
	@mkdir -p "$(SIYUAN_WORKSPACE)" "$(DIST_DIR)"
	@started=0; \
	if docker container inspect "$(SIYUAN_CONTAINER)" >/dev/null 2>&1; then \
		if [ "$$(docker container inspect --format '{{.State.Running}}' "$(SIYUAN_CONTAINER)")" != "true" ]; then \
			docker container start "$(SIYUAN_CONTAINER)" >/dev/null || exit 1; \
			started=1; \
		fi; \
	else \
		docker run --detach \
			--name "$(SIYUAN_CONTAINER)" \
			--publish "127.0.0.1:$(SIYUAN_PORT):6806" \
			--env "SIYUAN_ACCESS_AUTH_CODE_BYPASS=$(SIYUAN_ACCESS_AUTH_CODE_BYPASS)" \
			--volume "$(DIST_DIR):/siyuan/workspace/data/plugins/siyuan-linkmark" \
			--volume "$(SIYUAN_WORKSPACE):/siyuan/workspace" \
			"$(SIYUAN_IMAGE)" serve \
			--workspace=/siyuan/workspace \
			--accessAuthCode="$(SIYUAN_ACCESS_AUTH_CODE)" >/dev/null || exit 1; \
		started=1; \
	fi; \
	if [ "$$started" -eq 1 ]; then \
		sleep 2; \
		npm run build; \
	fi

dev-stop:
	@tmux kill-session -t "$(DEV_TMUX_SESSION)" 2>/dev/null || true
	@if docker container inspect "$(SIYUAN_CONTAINER)" >/dev/null 2>&1; then \
		docker container stop "$(SIYUAN_CONTAINER)" >/dev/null; \
	fi
	@echo "Development environment stopped"
