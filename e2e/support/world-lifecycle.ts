// The end-to-end scenario shared by every game: new world -> live -> service
// active -> marker next to the save -> save & stop -> dormant -> start -> live,
// service active, marker still there. Per-game differences live in `WorldGame`.

import { expect, type Page } from "@playwright/test";
import { containerExists, containerName, exec, sleep, waitForServiceActive } from "./docker.ts";

export interface WorldGame {
  // Game label as the panel shows it, e.g. "Factorio" (new-world input aria-label).
  label: string;
  // systemd unit that runs the game inside the container.
  service: string;
  // A directory next to the game's save, writable for the marker file.
  saveDir: string;
  // How long a fresh install may take until the service is active.
  installTimeoutMs: number;
}

export const GAME_UI = {
  newWorld: "NY VÄRLD",
  stop: "SPARA & STÄNG",
  start: "STARTA",
  live: "ONLINE",
  dormant: "SOVANDE",
} as const;

export interface LifecycleOptions {
  page: Page;
  game: WorldGame;
  namespace: string;
  password: string;
  worldName: string;
}

export async function login(page: Page, password: string) {
  await page.goto("/");
  const input = page.getByLabel("Lösenord");
  const submit = page.getByRole("button", { name: "LOGGA IN" });
  // Text typed before React hydrates is lost to the controlled input, so
  // retry the fill until the submit button (disabled while empty) is enabled.
  await expect(async () => {
    // Clear first: refilling identical text raises no change event for React.
    await input.fill("");
    await input.fill(password);
    await expect(submit).toBeEnabled({ timeout: 1000 });
  }).toPass();
  await submit.click();
  await expect(page.getByRole("button", { name: "LOGGA UT" })).toBeVisible();
}

export async function runWorldLifecycle({
  page,
  game,
  namespace,
  password,
  worldName,
}: LifecycleOptions) {
  const container = containerName(namespace, worldName);
  const card = page.locator(`[data-testid="world-card"][data-world="${worldName}"]`);
  const markerFile = `${game.saveDir}/e2e-marker.txt`;
  const marker = `marker-${Date.now()}`;

  await login(page, password);

  // New world.
  const form = page.locator("form").filter({
    has: page.getByLabel(`Namn på ny ${game.label}-värld`),
  });
  await form.getByLabel(`Namn på ny ${game.label}-värld`).fill(worldName);
  await form.getByRole("button", { name: GAME_UI.newWorld }).click();

  // Card goes live, then the game service comes up inside the container.
  await expect(card).toContainText(GAME_UI.live, { timeout: 5 * 60_000 });
  await waitForServiceActive(container, game.service, game.installTimeoutMs);

  // Marker next to the save.
  const write = await exec(container, ["sh", "-c", `echo ${marker} > ${markerFile} && sync`]);
  expect(write.code).toBe(0);

  // Save & stop -> dormant card, container gone.
  await card.getByRole("button", { name: GAME_UI.stop }).click();
  await expect(card).toContainText(GAME_UI.dormant, { timeout: 10 * 60_000 });
  expect(await containerExists(container)).toBe(false);

  // Start -> live again with the game running and the marker restored.
  await card.getByRole("button", { name: GAME_UI.start }).click();
  await expect(card).toContainText(GAME_UI.live, { timeout: 5 * 60_000 });
  await waitForServiceActive(container, game.service, 5 * 60_000);
  await sleep(500);
  const read = await exec(container, ["cat", markerFile]);
  expect(read.out).toBe(marker);
}
