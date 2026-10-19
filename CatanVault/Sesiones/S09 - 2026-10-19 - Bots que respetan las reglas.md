---
tags: [sesion]
fecha: 2026-10-19
commits: 026d45a
---

# S09 - 2026-10-19 - Bots que respetan las reglas

Llegó otro comentario de un jugador: «a veces rompe las reglas: el bot pone el ladrón en la misma casilla donde ya está y construye un camino que atraviesa tu poblado». Se investigó y se arregló en una sola sesión, y ya está publicado.

## Qué se hizo

### Diagnóstico (sin commit)
Las comprobaciones del motor (`js/engine/game.js`) eran correctas. Para no fiarse solo de leer el código, se escribió un árbitro estricto (un script en el scratchpad, fuera del repo) que juega cientos de partidas solo de bots y vigila cada jugada. En 300 partidas **el ladrón siempre cambió de casilla y todos los caminos conectaban de forma legal**. Lo que vio el jugador eran jugadas legales en el Catan real que parecen trampas:

- **Ladrón «en la misma casilla»:** en torno al 30 % de los movimientos devolvían el ladrón a la casilla de la que acababa de salir. Pasaba cuando un bot deshacía el movimiento del jugador anterior, o en el mismo turno cuando jugaba un caballero y luego sacaba un 7. A la vista, el ladrón parecía no moverse.
- **Camino «a través de tu poblado»:** un rival puede tener dos caminos que llegan a tu casa por lados distintos, cada uno conectado por su otro extremo. En 3D se dibujaba una junta redonda justo debajo de tu casa, así que parecía un único camino que la atravesaba. Además, la forma en que los bots puntuaban los caminos tenía un fallo: valoraba los dos extremos del camino, incluido el extremo del que sale. Por eso un camino que moría en una casa rival podía salir elegido.
- También se vio que el simulador `tests/sim.mjs` aceptaba como «conectado» un camino que solo enlazaba pasando por un edificio rival, así que no podía detectar este caso.

### Arreglo — `026d45a`
- **Ladrón:** el motor guarda de qué casilla salió el ladrón (`board.robberFrom`), tanto cuando lo mueve un jugador como cuando lo mueve el evento de tormenta. Los bots ya no lo devuelven a esa casilla, salvo que sea la única opción.
- **Caminos de los bots:** `bestRoad` en `js/engine/bot.js` puntúa solo el extremo hacia el que crece el camino y descarta los caminos que tocan un edificio rival (un callejón sin salida).
- **Dibujo 3D:** en `js/ui/board3d.js` no se dibuja la junta de un camino bajo la casa de otro jugador, así que la tabla se queda corta y el camino se ve cortado. El tablero 2D ya acortaba los caminos y no necesitó cambios.
- **Tests:** `tests/sim.mjs` falla si el ladrón se queda en su casilla o si un camino nuevo no conecta respetando los edificios rivales. Se comprueba en el momento de construirlo, porque un rival sí puede cortarlo después poniendo un poblado en medio.

## Decisiones
- No se tocaron las reglas del motor: devolver el ladrón a la casilla anterior y llegar con caminos a una casa rival son legales en Catan. Solo cambian los bots y el dibujo.
- El usuario pidió hacer commit y push para publicarlo («Sí, haz commit y push para publicarlo»).

## Respuesta propuesta para el jugador (Reddit, en inglés)
> Thanks! Both were legal moves that looked like cheating, but they're fixed now. Bots no longer move the robber back to the tile it just left, and roads now visibly stop at rival settlements.

Todavía no se ha publicado.

## Verificación
- `npm test`: 19 tests de reglas bien y 300 partidas simuladas sin errores.
- Árbitro antes y después: las vueltas del ladrón a su casilla anterior bajaron de unas 720 a 0. Ya no aparecen caminos de bots que acaben atravesando una casa rival. Lo único que queda es alguien que pone un poblado entre dos caminos de un rival, que es un corte legal.
- La fuerza de los bots no cambió: 52,3 turnos de media antes y 52,5 después.
- En el navegador se comprobó el 3D poniendo a mano dos caminos azules a los lados de una casa roja: las tablas se quedan antes de la casa. **No se vio en una partida real**, y tampoco en móvil ni online.
- Se confirmó que GitHub Pages ya sirve el `bot.js` nuevo.

## Archivos importantes
- `js/engine/game.js`: `robberFrom` en `moveRobber` y en el evento de tormenta.
- `js/engine/bot.js`: elección de casilla del ladrón y `bestRoad`.
- `js/ui/board3d.js`: juntas de los caminos.
- `tests/sim.mjs`: comprobaciones estrictas del ladrón y de los caminos.
