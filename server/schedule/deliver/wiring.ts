/** Builds the delivery pieces once, on the app's own settings, for the boot to hang on the engine. */
import type { Database } from "bun:sqlite";
import { getAppSettings } from "../../services/app-settings";
import { createOwnerAlert } from "./owner-alert";
import { createDeliveryRegistry } from "./registry";
import { createRunDelivery } from "./run-delivery";
import { createSender } from "./send";
import { parseDeliverySettings, type DeliverySettings } from "./settings";

export function createScheduleDelivery(db: Database, now: () => Date) {
  /** Read at every use: the person changes the setting while the app runs. */
  const settings = (): DeliverySettings => parseDeliverySettings(getAppSettings().scheduledDelivery);
  const registry = createDeliveryRegistry(db, now);
  const sender = createSender({ registry, settings });
  const alert = createOwnerAlert({ db, sender, settings, now });
  const delivery = createRunDelivery({ db, sender, alert, settings, now });
  // A send that was mid-way when the last process stopped may have gone out: it is judged here, once, and never started again.
  registry.recoverAtBoot();
  return { settings, registry, sender, alert, delivery };
}
