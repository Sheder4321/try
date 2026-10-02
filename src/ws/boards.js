const WebSocket = require("ws");

function setupBoardSocket(wss) {
  const rooms = new Map();

  wss.on("connection", (ws, req) => {
    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.type) {
          case "sync_request":
            if (ws.roomId && rooms.has(ws.roomId)) {
              const clients = rooms.get(ws.roomId);
              clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                      type: "sync_request",
                      boardId: ws.roomId,
                      userId: ws.userId,
                    }),
                  );
                }
              });
            }
            break;

          case "undo":
          case "redo":
            if (ws.roomId && rooms.has(ws.roomId)) {
              const clients = rooms.get(ws.roomId);
              clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                      type: data.type,
                      boardId: ws.roomId,
                      data: data.data,
                      userId: ws.userId,
                      userName: ws.userName || "Пользователь",
                    }),
                  );
                }
              });
            }
            break;

          case "join":
            const roomId = data.roomId;
            ws.roomId = roomId;
            ws.userId = data.userId;
            ws.role = data.role;

            // Удаляем соединение из ВСЕХ старых комнат, чтобы не получать
            // и не отправлять сообщения других досок
            rooms.forEach((clients, rId) => {
              clients.delete(ws);
              if (clients.size === 0) {
                rooms.delete(rId);
              }
            });

            if (!rooms.has(roomId)) {
              rooms.set(roomId, new Set());
            }
            rooms.get(roomId).add(ws);
            break;

          case "draw":
            if (ws.roomId && rooms.has(ws.roomId)) {
              const clients = rooms.get(ws.roomId);
              clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                      type: "draw",
                      boardId: ws.roomId,
                      data: {
                        ...data.data,
                        userId: ws.userId, // ← ПРОКИДЫВАЕМ userId ВНУТРЬ data
                      },
                    }),
                  );
                }
              });
            }
            break;

          case "clear":
            if (ws.roomId && rooms.has(ws.roomId)) {
              const clients = rooms.get(ws.roomId);
              clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: "clear", boardId: ws.roomId }));
                }
              });
            }
            break;

          case "sync":
            if (ws.roomId && rooms.has(ws.roomId)) {
              const clients = rooms.get(ws.roomId);
              clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                      type: "sync",
                      boardId: ws.roomId,
                      data: data.data,
                    }),
                  );
                }
              });
            }
            break;

          case "leave":
            if (ws.roomId && rooms.has(ws.roomId)) {
              rooms.get(ws.roomId).delete(ws);
              if (rooms.get(ws.roomId).size === 0) {
                rooms.delete(ws.roomId);
              }
            }
            break;
        }
      } catch (error) {
        console.error("❌ Ошибка WebSocket:", error);
      }
    });

    ws.on("close", () => {
      if (ws.roomId && rooms.has(ws.roomId)) {
        rooms.get(ws.roomId).delete(ws);
        if (rooms.get(ws.roomId).size === 0) {
          rooms.delete(ws.roomId);
        }
      }
    });
  });
}

module.exports = { setupBoardSocket };