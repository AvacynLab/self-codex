#!/usr/bin/env tsx

import { seedSampleValidationData } from "../src/validationRun/sampleData.js";

async function main(): Promise<void> {
  try {
    await seedSampleValidationData();
    console.log("✔ Données de validation synthétiques écrites dans validation_run/.");
  } catch (error) {
    console.error("✖ Génération des données d'exemple échouée:", error);
    process.exitCode = 1;
  }
}

void main();
