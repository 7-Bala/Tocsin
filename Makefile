.PHONY: run dev stop logs

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
