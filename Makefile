SIYUAN_CONTAINER ?= siyuan-linkmark-siyuan-dev
SIYUAN_IMAGE ?= b3log/siyuan:latest
SIYUAN_PORT ?= 6806
SIYUAN_ACCESS_AUTH_CODE ?= siyuan-linkmark-dev
SIYUAN_WORKSPACE ?= $(CURDIR)/dev/siyuan-workspace
DIST_DIR := $(CURDIR)/dist

.PHONY: dev dev-container dev-stop

dev: dev-container
	npm run dev

dev-container:
	@mkdir -p "$(SIYUAN_WORKSPACE)" "$(DIST_DIR)"
	@if docker container inspect "$(SIYUAN_CONTAINER)" >/dev/null 2>&1; then \
		if [ "$$(docker container inspect --format '{{.State.Running}}' "$(SIYUAN_CONTAINER)")" != "true" ]; then \
			docker container start "$(SIYUAN_CONTAINER)"; \
		fi; \
	else \
		docker run --detach \
			--name "$(SIYUAN_CONTAINER)" \
			--publish "127.0.0.1:$(SIYUAN_PORT):6806" \
			--volume "$(DIST_DIR):/siyuan/workspace/data/plugins/siyuan-linkmark" \
			--volume "$(SIYUAN_WORKSPACE):/siyuan/workspace" \
			"$(SIYUAN_IMAGE)" serve \
			--workspace=/siyuan/workspace \
			--accessAuthCode="$(SIYUAN_ACCESS_AUTH_CODE)"; \
	fi

dev-stop:
	@if docker container inspect "$(SIYUAN_CONTAINER)" >/dev/null 2>&1; then \
		docker container stop "$(SIYUAN_CONTAINER)"; \
	fi
