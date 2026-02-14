docker compose -f docker-compose.microservices.yml up -d --build frontend

docker compose -f docker-compose.microservices.yml down
docker compose -f docker-compose.microservices.yml up -d --build
