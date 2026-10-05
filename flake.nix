{
  description = "HKUST course-tree: local Flask course-selection helper";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # Single place where the interpreter and its pinned package set live, so
      # the shell cannot drift from the documented dependency list.
      pythonFor =
        pkgs:
        pkgs.python3.withPackages (
          ps: with ps; [
            flask
            beautifulsoup4
            requests
            pytest
          ]
        );
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          python = pythonFor pkgs;
        in
        {
          default = pkgs.mkShell {
            packages = [ python ];

            shellHook = ''
              # Import `hkust_tree` from the checkout instead of installing it,
              # so edits take effect immediately with no rebuild step.
              project_root="$PWD"
              while [ "$project_root" != "/" ] && [ ! -f "$project_root/flake.nix" ]; do
                project_root="$(dirname "$project_root")"
              done
              export HKUST_TREE_ROOT="$project_root"
              export PYTHONPATH="$project_root''${PYTHONPATH:+:$PYTHONPATH}"

              # Only greet interactive shells, so `nix develop -c <cmd>` and
              # scripts stay quiet.
              case $- in
                *i*)
                  echo "HKUST course tree dev shell"
                  echo "  python: $(${python}/bin/python --version 2>&1)"
                  echo "  run:    python -m hkust_tree    (http://127.0.0.1:5000)"
                  echo "  test:   python -m pytest -q"
                  ;;
              esac
            '';
          };
        }
      );

      # `nix fmt` formats the whole tree (flake.nix and any .nix files added later).
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt-tree);
    };
}
