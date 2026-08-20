.PHONY: run dev stop logs pack pack-md pack-compress

# Default: single command to auto-open Docker & start entire stack
run:
	./start.sh

# Run detached in background
dev:
	./start.sh -d

# View live logs
logs:
	docker compose logs -f

# Stop and remove containers
stop:
	docker compose down

# Repomix pack for AI agents (XML format)
pack:
	npx repomix

# Repomix pack in Markdown format
pack-md:
	npx repomix --style markdown -o repomix-output.md

# Repomix pack compressed (Tree-sitter signature extraction)
pack-compress:
	npx repomix --compress -o repomix-output-compressed.xml
