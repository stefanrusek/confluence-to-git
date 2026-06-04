/**
 * Phase 1: Inventory. Enumerate every space, page and attachment so the import
 * phase has a complete, persistable work list.
 */
import type { ConfluenceClient } from "../confluence/client.ts";
import type { ConversionInventory, InventoryPageEntry, Logger } from "../types.ts";

export async function inventoryPhase(
  client: ConfluenceClient,
  logger: Logger,
): Promise<ConversionInventory> {
  logger.info("Phase 1: Inventory");
  const spaces = await client.getSpaces();
  logger.info(`Found ${spaces.length} spaces`);

  const pages: InventoryPageEntry[] = [];
  let totalAttachments = 0;

  for (const space of spaces) {
    const spacePages = await client.getPages(space.key);
    logger.debug(`Space ${space.key}: ${spacePages.length} pages`);
    for (const page of spacePages) {
      const attachments = await client.getAttachments(page.id);
      totalAttachments += attachments.length;
      pages.push({
        page,
        spaceKey: space.key,
        attachmentCount: attachments.length,
        versionCount: page.version.number,
      });
    }
  }

  const inventory: ConversionInventory = {
    spaces,
    pages,
    totalPages: pages.length,
    totalAttachments,
    createdAt: new Date().toISOString(),
  };
  logger.info(
    `Inventory complete: ${spaces.length} spaces, ${pages.length} pages, ${totalAttachments} attachments`,
  );
  return inventory;
}
