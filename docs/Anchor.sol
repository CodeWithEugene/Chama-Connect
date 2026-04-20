// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ChamaPay Anchor
/// @notice Minimal contract that stores Merkle roots of settled chama contributions.
/// @dev    Any EVM chain works; we default to Base Sepolia for near-zero fees.
contract Anchor {
    event Anchored(address indexed publisher, bytes32 indexed root, bytes32 metaHash, uint256 ts);

    // publisher → latest root they pushed (optional convenience)
    mapping(address => bytes32) public latestRoot;

    // root → timestamp (0 if never anchored)
    mapping(bytes32 => uint256) public anchoredAt;

    function anchorRoot(bytes32 root, bytes32 metaHash) external {
        require(root != bytes32(0), "empty root");
        anchoredAt[root] = block.timestamp;
        latestRoot[msg.sender] = root;
        emit Anchored(msg.sender, root, metaHash, block.timestamp);
    }

    function exists(bytes32 root) external view returns (bool) {
        return anchoredAt[root] != 0;
    }
}
