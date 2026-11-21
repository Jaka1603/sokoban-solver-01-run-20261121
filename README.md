# Push-Optimal Rooms — a Sokoban solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Jaka1603/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Jaka1603/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A Sokoban solver that answers in the fewest pushes there are. Every level
of this competition is a one-square hallway with independent rooms off it,
and a box pushed out of its room can never come back — so a level's push
optimum is exactly the sum of its rooms' push optima. The solver cuts the
level into its rooms along the dead squares of the hallway row, then solves
each room on its own.

Each room is solved by an A* search over pushes (never over steps) whose
estimate is a minimum-cost matching of boxes to goals over true push
distances — one reverse pull search per goal. The estimate never overstates
the pushes remaining, so the first solution the search settles is
push-optimal for the room, and the rooms add up to the level's optimum.
Dead squares, frozen 2 x 2 blocks and boxes the matching can place on no
goal prune the states no solution passes through.

The player is carried from room to room, unsolved rooms stand as walls
(their boxes, or their goals once done), and the walks between pushes are
shortest paths. All budgets are counted in states expanded, never by the
clock, and every tie breaks by square order — two runs write the same
bytes. On the kit's practice set the solver answers all five instances in
exactly the reference push counts (13, 16, 29, 47, 60) in about a quarter
of a second.

## Layout

- `main.ts` — the whole solver: parser, room cut, push A*, move writer.
- Node 22, no dependencies: `node main.ts` reads `/input/<id>/level.txt`
  and writes `/output/<id>/solution.txt` (the `MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR` variables stand in for those paths locally).
