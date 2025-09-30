// Pipeline de CI/CD pour démonstration Graph Forge
// Les attributs duration et cost sont utilisés par les scripts locaux
// pour simuler une planification et des optimisations simples.

graph Pipeline {
  directive allowCycles false;

  node lint_core        { label: "Lint coeur",           duration: 3, cost: 1.5 }
  node lint_ui          { label: "Lint UI",              duration: 2, cost: 1.2 }
  node lint_api         { label: "Lint API",             duration: 2, cost: 1.1 }
  node test_unit        { label: "Tests unitaires",      duration: 5, cost: 3.5 }
  node test_integration { label: "Tests d'intégration",  duration: 8, cost: 4.2 }
  node build_bundle     { label: "Build",                duration: 6, cost: 4.0 }
  node docs_generate    { label: "Documentation",        duration: 3, cost: 1.8 }
  node package_artifacts { label: "Packaging",            duration: 4, cost: 2.0 }

  edge lint_core -> test_unit         { weight: 3 }
  edge lint_ui -> test_unit           { weight: 2 }
  edge lint_api -> test_unit          { weight: 2 }
  edge test_unit -> test_integration  { weight: 5 }
  edge test_unit -> build_bundle      { weight: 5 }
  edge test_integration -> build_bundle { weight: 8 }
  edge build_bundle -> docs_generate  { weight: 6 }
  edge build_bundle -> package_artifacts { weight: 6 }
  edge docs_generate -> package_artifacts { weight: 3 }
}
