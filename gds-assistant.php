<?php

/*
Plugin Name:  GDS Assistant
Plugin URI:   https://genero.fi
Description:  AI-powered admin assistant with WordPress tool access
Version:      0.1.0
Requires at least: 6.5
Tested up to: 7.0
Requires PHP: 8.0
Author:       Genero
Author URI:   https://genero.fi/
License:      MIT License
License URI:  http://opensource.org/licenses/MIT
*/

use GeneroWP\Assistant\Plugin;

if (! defined('ABSPATH')) {
    exit;
}

if (file_exists($composer = __DIR__.'/vendor/autoload.php')) {
    require_once $composer;
}

Plugin::getInstance();
